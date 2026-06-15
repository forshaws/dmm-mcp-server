// similarity.js — Multi-call similarity orchestration for TQNN DMM
// TQNN MCP Server v1.0.0
//
// The similarity search algorithm lives entirely here — NOT inside DMM.
// DMM only sees individual searchDoc calls with PQR-hashed tokens.
// This is intentional: the intelligence is in the client layer.
// DMM remains a pure associative memory primitive.

const crypto = require('crypto');
const { tokenise } = require('./tokeniser');

// ---------------------------------------------------------------------------
// PQR Hashing — mirrors lindisfarne_similarity_search.py exactly
// SHA-256 of the token padded/truncated to exactly 16 characters.
// Pad character is '*'.
// ---------------------------------------------------------------------------

function pad16(s) {
  s = String(s);
  return s.length >= 16 ? s.slice(0, 16) : s.padEnd(16, '*');
}

/**
 * PQR hash — forward (standard).
 * @param {string} token
 * @returns {string} hex SHA-256
 */
function pqrHash(token) {
  return crypto.createHash('sha256').update(pad16(token), 'utf8').digest('hex');
}

/**
 * PQR hash — reversed INPUT string (for FPD).
 * IMPORTANT: We reverse the token INPUT string before pad+hash.
 * NOT the hash output. This mirrors the Python FPD implementation.
 * @param {string} token
 * @returns {string} hex SHA-256
 */
function pqrHashReversed(token) {
  const reversed = token.split('').reverse().join('');
  return crypto.createHash('sha256').update(pad16(reversed), 'utf8').digest('hex');
}

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
 * Find documents similar to free-text input using token overlap scoring.
 * Tokenises the input, searches DMM for each token (with optional FPD),
 * counts per-document token hits, ranks by overlap, applies threshold.
 *
 * @param {TQNNClient} client
 * @param {string} text - Free text (question, sentence, paragraph, keyword list)
 * @param {object} options
 * @param {number} [options.threshold=0.4] - Minimum token overlap fraction (0.0–1.0)
 * @param {string} [options.dataset=''] - Target dataset/namespace
 * @param {boolean} [options.fpd=true] - Enable False Positive Defence
 * @param {number} [options.maxResults=20] - Maximum results to return
 * @returns {Promise<SimilarityResult>}
 */
async function similaritySearch(client, text, {
  threshold = 0.4,
  dataset = '',
  fpd = true,
  maxResults = 20
} = {}) {
  const tokens = tokenise(text);
  if (tokens.length === 0) {
    return {
      tokens_used: [],
      tokens_searched: 0,
      matches_found: 0,
      threshold_pct: threshold * 100,
      results: [],
      message: 'No searchable tokens found in input text.'
    };
  }

  const hitCounts = new Map(); // canonical_ref (stripped) → hit count
  let searched = 0;

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
    const seenThisToken = new Set();
    for (const ref of refs) {
      const key = stripTimestamp(ref);
      if (!seenThisToken.has(key)) {
        seenThisToken.add(key);
        hitCounts.set(key, (hitCounts.get(key) || 0) + 1);
      }
    }
  }

  const cutoff = searched * threshold;
  const matched = [...hitCounts.entries()]
    .filter(([, hits]) => hits >= cutoff)
    .sort((a, b) => b[1] - a[1]) // highest overlap first
    .slice(0, maxResults)
    .map(([ref, hits]) => ({
      filereference: ref,
      token_hits: hits,
      overlap_pct: Math.round((hits / searched) * 100 * 10) / 10
    }));

  return {
    tokens_used: tokens,
    tokens_searched: searched,
    matches_found: matched.length,
    threshold_pct: threshold * 100,
    results: matched
  };
}

module.exports = { similaritySearch, pqrHash, pqrHashReversed, searchToken, parseFilelist, stripTimestamp, tokenise };
