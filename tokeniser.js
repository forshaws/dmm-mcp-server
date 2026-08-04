// tokeniser.js — General-purpose tokeniser for TQNN similarity search
// Ported from lindisfarne_similarity_search.py
// V1.3.1 — Preserve token case for PQR hashing (self-salting scheme is case-sensitive)
// V1.4.0 — Pruned medical stopwords that carry clinical signal (severity, laterality,
//   chronicity, diagnostic category); added ACRONYM_ALLOWLIST so short but meaningful
//   domain tokens (MRI, CT, PET, ...) survive MIN_TOKEN_LENGTH.

const STOPWORDS = new Set([
  // Generic English stopwords
  "this", "that", "with", "from", "they", "them", "their", "what",
  "will", "have", "been", "were", "when", "where", "which", "there",
  "some", "more", "also", "than", "then", "into", "your", "about",
  "would", "could", "should", "each", "other", "these", "those",
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
  "stage", "with", "and", "the", "due", "related",
  "associated", "onset"
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
  "PNS", "GI", "GU", "CSF", "WBC", "RBC", "BMD", "DXA", "EMG"
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
  const words = text.match(/[a-zA-Z]+/g) || [];
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
