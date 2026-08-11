// tokeniser.js — General-purpose tokeniser for TQNN similarity search
// Ported from lindisfarne_similarity_search.py
// V1.3.1 — Preserve token case for PQR hashing (self-salting scheme is case-sensitive)
// V1.4.0 — Pruned medical stopwords that carry clinical signal (severity, laterality,
//   chronicity, diagnostic category); added ACRONYM_ALLOWLIST so short but meaningful
//   domain tokens (MRI, CT, PET, ...) survive MIN_TOKEN_LENGTH.
// V1.5.0 — Merged in DOMAIN_FILTER_STOPWORDS (the ingest-side stopword list used by
//   build_shard_tokens_biblio.py / count_unique_tokens.py / sample_surviving_tokens.py
//   at store time) as a superset of this query-side list. Root-caused via the
//   2026-08-07 130-query benchmark: "before" and "through" were filtered out of the
//   index at ingest time but NOT filtered from queries here, so any query containing
//   either word was structurally guaranteed docCount=0 for that token, regardless of
//   corpus content — this alone accounted for 7 of 8 zero-match queries in that
//   benchmark, including every "technique" intent query ("what imaging is needed
//   before [procedure]"). Query-side only, no re-ingest needed. Checked against the
//   V1.4.0 clinical-modifier exceptions (disease, disorder, syndrome, familial, acute,
//   chronic, severe, mild, moderate, bilateral, unilateral, left, right, early, late,
//   primary, secondary) — none of them appear in DOMAIN_FILTER_STOPWORDS, so no
//   conflict; those terms remain un-stopworded exactly as before.
// V1.6.0 — Three fixes from live per-query diagnosis against the Radiology Academy
//   benchmark (definition_03, definition_06, definition_02 all confirmed broken by
//   these, live against the appliance, 2026-08-11):
//   (1) Tokenising regex was letters-only ([a-zA-Z]+), so "T2" was never actually
//       failing the ACRONYM_ALLOWLIST check — it never REACHED it. The regex itself
//       split "T2" into a bare "T" (digit outside the match), which is 1 char, not
//       itself allowlisted, and got dropped before isAllowed/passesLength ever ran.
//       Changed to /[a-zA-Z][a-zA-Z0-9]*/g (must start with a letter, may contain
//       trailing digits) so "T1"/"T2" survive as single tokens and reach the
//       allowlist check as originally intended. Confirmed via live searchDoc calls:
//       "T2" was previously silently absent from tokens_used on every query
//       containing it.
//   (2) Added "ADC", "DWI" to ACRONYM_ALLOWLIST — confirmed missing via live testing:
//       "What does restricted ADC value indicate on DWI?" (definition_06) tokenised
//       to just ["restricted", "indicate"] — both 3-letter imaging acronyms were
//       silently dropped, discarding the two words the entire question hinges on.
//   (3) Added instruction-verb stopwords (define/describe/explain/list/identify/
//       summarize/discuss/outline + inflections) — these were already added to the
//       INGEST-side stopword file (stopwords_radiology_metadata.txt) during offline
//       retrieval testing, but never deployed to this, the live query-side path.
//       Confirmed live: "Define washout in contrast-enhanced liver imaging"
//       (definition_02) kept "Define" as a real search token — capitalized,
//       sentence-initial, which (per the case-sensitive hash chain) gets an
//       artificially rare/high weight versus the same word lowercased mid-sentence,
//       distorting ranking. STOPWORDS lookups are case-insensitive
//       (word.toLowerCase()), so stopwording "define" here correctly strips it
//       regardless of capitalization — no separate case-policy fix needed for this
//       specific class of word. Deliberately did NOT stopword "compare"/"compares"
//       (only "comparing"/"comparison"/"compared") — real corpus docCount testing
//       during offline retrieval work showed "compare" behaves like genuine
//       clinical-frequency vocabulary, not scaffolding; flagged there as
//       lower-confidence and worth revisiting with real corpus-bloat evidence, so
//       left as-is here rather than guessed at.

const STOPWORDS = new Set([
  // Generic English stopwords (merged superset of the original hand-curated
  // list here and DOMAIN_FILTER_STOPWORDS from build_shard_tokens_biblio.py —
  // see V1.5.0 note above)
  "a", "about", "after", "again", "all", "also", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "could", "did", "do", "does", "doing", "down", "during",
  "each", "few", "for", "from", "further",
  "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him",
  "himself", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "itself",
  "just",
  "may", "me", "might", "more", "most", "must", "my", "myself",
  "no", "nor", "not", "now",
  "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out",
  "over", "own",
  "same", "she", "should", "so", "some", "such",
  "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up",
  "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "will", "with", "would",
  "you", "your", "yours", "yourself", "yourselves",
  // Domain-neutral common words
  "data", "file", "document", "record", "report", "system", "user",
  "type", "date", "time", "name", "list", "item", "value", "field",
  // Medical domain (pruned V1.4.0 — removed clinically load-bearing terms:
  // disease, disorder, syndrome, familial, acute, chronic, severe, mild,
  // moderate, bilateral, unilateral, left, right, early, late, primary,
  // secondary. These modify or classify a finding rather than scaffold a
  // sentence, and stripping them discards clinically decisive information
  // — e.g. "severe" vs "mild" or "bilateral" vs "unilateral" can point to
  // different diagnoses entirely. Retained only genuinely structural terms.
  // (with/and/the already covered by the merged generic list above.)
  "stage", "due", "related", "associated", "onset",
  // Query-only instruction verbs (V1.6.0) — a chunk of real prose never
  // literally contains the word "Define"/"Describe"/etc., so these only ever
  // survive as an artifact of how the QUESTION was phrased, not as signal
  // about what a matching passage should contain. Matches the list already
  // in use on the ingest-side stopword file (stopwords_radiology_metadata.txt)
  // from offline retrieval testing — deploying it here closes the gap between
  // the two. Deliberately excludes "compare"/"compares" — see V1.6.0 note above.
  "define", "defines", "defining", "definition",
  "describe", "describes", "describing",
  "explain", "explains", "explaining",
  "lists", "listing",
  "identify", "identifies", "identifying",
  "summarize", "summarizes", "summarizing",
  "discuss", "discusses", "discussing",
  "outline", "outlines", "outlining",
  "comparing", "comparison", "compared"
]);

// Short (< MIN_TOKEN_LENGTH) tokens that are still meaningful and should not
// be silently dropped — primarily imaging-modality and clinical acronyms.
// Checked case-insensitively; matched tokens bypass the length filter only,
// they are still subject to STOPWORDS and deduplication as normal.
// Extend as new short domain-critical terms are found (e.g. via benchmark
// query review) — this list is not exhaustive.
const ACRONYM_ALLOWLIST = new Set([
  "MRI", "CT", "PET", "MRA", "CTA", "MR", "US", "CXR", "AP", "PA",
  "T1", "T2", "OM", "DFI", "DFO", "ESR", "CRP", "IV", "IM", "CNS",
  "PNS", "GI", "GU", "CSF", "WBC", "RBC", "BMD", "DXA", "EMG",
  // Added V1.6.0 — confirmed missing via live benchmark diagnosis
  // (definition_06: "restricted ADC value ... DWI" tokenised to neither).
  "ADC", "DWI"
]);

const MIN_TOKEN_LENGTH = 4;

/**
 * Tokenise free text into meaningful search tokens.
 * Strips stopwords, deduplicates, enforces minimum length — except for
 * tokens on ACRONYM_ALLOWLIST, which bypass the length check.
 * Case is PRESERVED — PQR self-salting scheme (V1.3.0+) is case-sensitive.
 * Stopword and allowlist matching are both case-insensitive.
 * @param {string} text - Any free text input
 * @returns {string[]} - Array of unique meaningful tokens (original case retained)
 */
function tokenise(text) {
  const words = text.match(/[a-zA-Z][a-zA-Z0-9]*/g) || [];
  const seen = new Set();
  const tokens = [];
  for (const word of words) {
    const isAllowed = ACRONYM_ALLOWLIST.has(word.toUpperCase());
    const passesLength = word.length >= MIN_TOKEN_LENGTH || isAllowed;
    if (passesLength && !STOPWORDS.has(word.toLowerCase()) && !seen.has(word)) {
      seen.add(word);
      tokens.push(word);
    }
  }
  return tokens;
}

module.exports = { tokenise, ACRONYM_ALLOWLIST };
