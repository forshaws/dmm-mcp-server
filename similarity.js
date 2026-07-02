// similarity.js — Multi-call similarity orchestration for TQNN DMM
// TQNN MCP Server v1.4.0
//
// The similarity search algorithm lives entirely here — NOT inside DMM.
// DMM only sees individual searchDoc calls with PQR-hashed tokens.
// This is intentional: the intelligence is in the client layer.
// DMM remains a pure associative memory primitive.
//
// v1.4.0 — Token weighting (IDF-style)
//   Previously every matched token contributed a flat +1 to a document's
//   score, regardless of how common or rare that token was across the
//   searched dataset. A token that hits 900 documents and a token that
//   hits 2 documents counted identically. This meant common tokens (e.g.
//   a protagonist's name repeated throughout a book, or a generic word
//   like "Diabetes" in a clinical corpus) could dominate ranking over
//   genuinely discriminating tokens (e.g. "Hatter", "lymphoma").
//
//   v1.4.0 introduces log-dampened inverse-document-frequency weighting:
//   rarer tokens (fewer matching documents) contribute more to a
//   document's score than common tokens. This changes RANKING and
//   THRESHOLD BEHAVIOUR only — it does not change what DMM stores,
//   how tokens are hashed, or how documents are fetched. Matching is
//   still exact-token, still fully client-side, still fully auditable.
//   No new DMM calls are introduced; document frequency is derived from
//   the same searchDoc responses already being made.

const crypto = require('crypto');
const { tokenise } = require('./tokeniser');

// ---------------------------------------------------------------------------
// PQR Hashing — Self-Salting scheme (V1.3.0+)
//
// Algorithm (mirrors storeDoc.php / tqnn_dmm_ide.html exactly):
//   1. h1     = SHA-256(input)          — 64 hex chars; endogenous salt
//   2. mixed  = input + h1              — salt appended to input
//   3. padded = mixed.slice(0, 16)      — first 16 chars
//   4. token  = SHA-256(padded).slice(0,16)
//
// Properties:
//   • Defeats rainbow tables — salt is derived from input itself
//   • All inputs lifted into full 2^256 hash space regardless of entropy
//   • No external key material, zero storage overhead, fully deterministic
//
// IMPORTANT: Re-ingest required for any dataset stored under the old '*' scheme.
// ---------------------------------------------------------------------------

/**
 * Self-Salting PQR token — canonical implementation.
 * @param {string} s - Input token (will be trimmed)
 * @returns {string} 16-char hex token
 */
function tqnnToken16(s) {
  const input  = String(s).trim();
  const h1     = crypto.createHash('sha256').update(input, 'utf8').digest('hex');
  const mixed  = input + h1;
  const padded = mixed.slice(0, 16);
  return crypto.createHash('sha256').update(padded, 'utf8').digest('hex').slice(0, 16);
}

/*
 * SUPERSEDED — V1.0.x constant-padding scheme (kept for reference / rollback)
 * Pad character '*' is vulnerable to rainbow table attacks on low-entropy fields.
 *
 * function pad16(s) {
 *   s = String(s);
 *   return s.length >= 16 ? s.slice(0, 16) : s.padEnd(16, '*');
 * }
 */

/**
 * PQR hash — forward (standard).
 * @param {string} token
 * @returns {string} 16-char hex token
 */
function pqrHash(token) {
  return tqnnToken16(token);
}

/*
 * SUPERSEDED — V1.0.x
 * function pqrHash(token) {
 *   return crypto.createHash('sha256').update(pad16(token), 'utf8').digest('hex');
 * }
 */

/**
 * PQR hash — reversed INPUT string (for FPD).
 * IMPORTANT: We reverse the token INPUT string before self-salting.
 * NOT the hash output. This mirrors the PHP/JS FPD implementations.
 * @param {string} token
 * @returns {string} 16-char hex token
 */
function pqrHashReversed(token) {
  return tqnnToken16(token.split('').reverse().join(''));
}

/*
 * SUPERSEDED — V1.0.x
 * function pqrHashReversed(token) {
 *   const reversed = token.split('').reverse().join('');
 *   return crypto.createHash('sha256').update(pad16(reversed), 'utf8').digest('hex');
 * }
 */

// ---------------------------------------------------------------------------
// Filelist parsing
// DMM returns filelist as a newline-delimited string, not a JSON array.
// Each entry has a DMM-appended ::unix_timestamp suffix.
// ---------------------------------------------------------------------------

/**
 * Parse DMM filelist response into an array of raw filereference strings.
 * @param {object} result - DMM API response
 * @returns {string[]}
 */
function parseFilelist(result) {
  const raw = result.filelist || '';
  return String(raw).split('\n').map(r => r.trim()).filter(Boolean);
}

/**
 * Strip DMM-appended ::timestamp, re-assert trailing ::.
 * e.g. "url://server/doc.pdf::1718123456" → "url://server/doc.pdf::"
 * @param {string} ref
 * @returns {string}
 */
function stripTimestamp(ref) {
  const match = ref.match(/^(.*?)::\d+$/);
  return match ? match[1] + '::' : ref;
}

// ---------------------------------------------------------------------------
// Token weighting — log-dampened IDF (v1.4.0)
// ---------------------------------------------------------------------------

/**
 * Compute the weight a single token contributes to a document's score,
 * based on how many documents that token matched (document frequency).
 * Rarer tokens (small docCount) get a higher weight; common tokens get
 * a lower weight. Log-dampened so one extremely rare token cannot
 * single-handedly dominate the ranking the way raw 1/docCount would.
 *
 * docCount=0  → weight = 1        (token matched nothing; contributes
 *                                   its full weight to the threshold
 *                                   denominator, making it effectively
 *                                   required for anything to pass)
 * docCount=1  → weight = 1 / log2(3)  ≈ 0.631
 * docCount=10 → weight = 1 / log2(12) ≈ 0.279
 * docCount=900→ weight = 1 / log2(902)≈ 0.103
 *
 * @param {number} docCount - Number of documents this token matched
 * @returns {number} weight, always > 0
 */
function tokenWeight(docCount) {
  return 1 / Math.log2(Math.max(docCount, 0) + 2);
}

// ---------------------------------------------------------------------------
// Token search — single token, optional FPD
// ---------------------------------------------------------------------------

/**
 * Search DMM for a single token with optional False Positive Defence (FPD).
 * FPD: make TWO searchDoc calls (forward + reversed token), AND the result sets.
 * Only filereferences in BOTH results are genuine.
 *
 * @param {TQNNClient} client
 * @param {string} token
 * @param {boolean} fpd - Enable False Positive Defence
 * @param {string} dataset - Dataset/namespace
 * @returns {Promise<string[]>} Array of original filereference strings (with timestamp)
 */
async function searchToken(client, token, fpd, dataset) {
  const fwdResult = await client.searchDoc(pqrHash(token), dataset);
  const fwdRefs = new Map(); // stripped → original
  for (const ref of parseFilelist(fwdResult)) {
    fwdRefs.set(stripTimestamp(ref), ref);
  }

  if (!fpd) return [...fwdRefs.values()];

  // FPD: reverse the token INPUT string, hash it, search again
  const revResult = await client.searchDoc(pqrHashReversed(token), dataset);
  const revStripped = new Set(parseFilelist(revResult).map(stripTimestamp));

  // Only refs present in BOTH forward AND reverse searches are genuine
  return [...fwdRefs.entries()]
    .filter(([stripped]) => revStripped.has(stripped))
    .map(([, orig]) => orig);
}

// ---------------------------------------------------------------------------
// Similarity search — main orchestration function
// ---------------------------------------------------------------------------

/**
 * Find documents similar to free-text input using weighted token overlap
 * scoring. Tokenises the input, searches DMM for each token (with optional
 * FPD), weights each token by rarity (log-dampened IDF over document
 * frequency within this search), sums per-document weighted score, ranks,
 * and applies threshold against total possible weight.
 *
 * This changes RANKING and THRESHOLD behaviour relative to pre-v1.4.0
 * (which used flat +1-per-token-hit counting). It does not change what
 * gets matched at the individual token level, how tokens are hashed, or
 * how many DMM calls are made — document frequency is derived from the
 * same searchDoc responses already returned by the existing FPD flow.
 *
 * @param {TQNNClient} client
 * @param {string} text - Free text (question, sentence, paragraph, keyword list)
 * @param {object} options
 * @param {number} [options.threshold=0.4] - Minimum weighted overlap fraction (0.0–1.0)
 * @param {string} [options.dataset=''] - Target dataset/namespace
 * @param {boolean} [options.fpd=true] - Enable False Positive Defence
 * @param {number} [options.maxResults=20] - Maximum results to return
 * @param {boolean} [options.weighted=true] - Use IDF-style token weighting.
 *   Set false to fall back to pre-v1.4.0 flat hit-counting behaviour.
 * @returns {Promise<SimilarityResult>}
 */
async function similaritySearch(client, text, {
  threshold = 0.4,
  dataset = '',
  fpd = true,
  maxResults = 20,
  weighted = true
} = {}) {
  const tokens = tokenise(text);
  if (tokens.length === 0) {
    return {
      tokens_used: [],
      tokens_searched: 0,
      matches_found: 0,
      threshold_pct: threshold * 100,
      weighted,
      results: [],
      message: 'No searchable tokens found in input text.'
    };
  }

  const docScores = new Map();  // canonical_ref (stripped) → weighted score
  const docHits = new Map();    // canonical_ref (stripped) → raw hit count (always tracked, for transparency)
  const tokenInfo = [];         // per-token diagnostics: { token, docCount, weight }
  let searched = 0;
  let totalWeight = 0;          // sum of weights for all successfully searched tokens — denominator for threshold

  for (const token of tokens) {
    let refs;
    try {
      refs = await searchToken(client, token, fpd, dataset);
    } catch (err) {
      // Log and continue — one failed token shouldn't abort the whole search
      process.stderr.write(`[tqnn-similarity] token "${token}" search failed: ${err.message}\n`);
      continue;
    }
    searched++;

    const docCount = refs.length;
    const weight = weighted ? tokenWeight(docCount) : 1;
    totalWeight += weight;
    tokenInfo.push({ token, docCount, weight: Math.round(weight * 1000) / 1000 });

    const seenThisToken = new Set();
    for (const ref of refs) {
      const key = stripTimestamp(ref);
      if (!seenThisToken.has(key)) {
        seenThisToken.add(key);
        docScores.set(key, (docScores.get(key) || 0) + weight);
        docHits.set(key, (docHits.get(key) || 0) + 1);
      }
    }
  }

  const cutoff = totalWeight * threshold;
  const matched = [...docScores.entries()]
    .filter(([, score]) => score >= cutoff)
    .sort((a, b) => b[1] - a[1]) // highest weighted score first
    .slice(0, maxResults)
    .map(([ref, score]) => ({
      filereference: ref,
      token_hits: docHits.get(ref) || 0,
      weighted_score: Math.round(score * 1000) / 1000,
      overlap_pct: Math.round((score / totalWeight) * 100 * 10) / 10
    }));

  return {
    tokens_used: tokens,
    tokens_searched: searched,
    matches_found: matched.length,
    threshold_pct: threshold * 100,
    weighted,
    token_weights: tokenInfo, // per-token doc frequency + weight, for auditability
    results: matched
  };
}

module.exports = {
  similaritySearch,
  pqrHash,
  pqrHashReversed,
  tqnnToken16,
  searchToken,
  parseFilelist,
  stripTimestamp,
  tokenise,
  tokenWeight
};
