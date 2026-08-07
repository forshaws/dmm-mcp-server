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
//
// v1.6.0 — Optional parallel per-token search
//   Per-token searchDoc() calls (one per query token, two under FPD) were
//   always made one-at-a-time in a `for...await` loop, so wall-clock time
//   scaled roughly linearly with token count. New `parallel` option (off
//   by default) fires all tokens' searches concurrently via Promise.all,
//   then folds results back into the same accumulators in original token
//   order — output (scores, ranking, diagnostics) is identical to the
//   sequential path either way; only the number of concurrent HTTP calls
//   to the DMM appliance changes. No change to the scoring algorithm.

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
 * v1.5.0 — also captures each underlying DMM call's self-reported timing
 * (time_used, billing_units, fc) so the caller can aggregate it rather than
 * it being silently dropped, as it was pre-v1.5.0. DMM's raw searchDoc
 * response already includes these fields (see tqnn-client.js's _post) —
 * this function previously read only `filelist` off that response and
 * discarded the rest.
 *
 * @param {TQNNClient} client
 * @param {string} token
 * @param {boolean} fpd - Enable False Positive Defence (ignored when pqr:false — nothing to reverse)
 * @param {string} dataset - Dataset/namespace
 * @param {boolean} [pqr=true] - PQR-hash the token before searching. Set false to search the
 *   raw token directly — for records stored via tqnn_store pqr:false (DMM's own storeDoc.php
 *   tokenises/keys every value regardless, so no client-side hashing is needed on this path).
 * @returns {Promise<{refs: string[], calls: Array<{pass: string, time_used: number|null, billing_units: number|null, fc: number|null}>}>}
 *   refs: original filereference strings (with timestamp), same as pre-v1.5.0's bare return.
 *   calls: one entry per DMM searchDoc call actually made for this token (1 normally, 2 under FPD).
 */
async function searchToken(client, token, fpd, dataset, pqr = true) {
  const calls = [];

  // DMM's raw response carries time_used (seconds), billing_units, fc
  // (fingerprint-cache size or similar internal counter), and an `energy`
  // block (energy_usage_kWh, carbon_emissions_mg, equivalent_meters_driven)
  // alongside filelist — pull out the timing/billing/energy fields here,
  // defensively, since older DMM versions or the memory:// in-process path
  // may not set them all.
  function recordCall(pass, dmmResult) {
    const e = dmmResult.energy || {};
    calls.push({
      pass,
      time_used: typeof dmmResult.time_used === 'number' ? dmmResult.time_used : null,
      billing_units: typeof dmmResult.billing_units === 'number' ? dmmResult.billing_units : null,
      fc: typeof dmmResult.fc === 'number' ? dmmResult.fc : null,
      energy_usage_kWh: e.energy_usage_kWh !== undefined ? Number(e.energy_usage_kWh) : null,
      carbon_emissions_mg: e.carbon_emissions_mg !== undefined ? Number(e.carbon_emissions_mg) : null,
      equivalent_meters_driven: e.equivalent_meters_driven !== undefined ? Number(e.equivalent_meters_driven) : null
    });
  }

  if (!pqr) {
    // Plain mode — no hashing, no FPD (there's no hash to reverse against).
    const fwdResult = await client.searchDoc(token, dataset);
    recordCall('forward_plain', fwdResult);
    const fwdRefs = new Map();
    for (const ref of parseFilelist(fwdResult)) {
      fwdRefs.set(stripTimestamp(ref), ref);
    }
    return { refs: [...fwdRefs.values()], calls };
  }

  const fwdResult = await client.searchDoc(pqrHash(token), dataset);
  recordCall('forward', fwdResult);
  const fwdRefs = new Map(); // stripped → original
  for (const ref of parseFilelist(fwdResult)) {
    fwdRefs.set(stripTimestamp(ref), ref);
  }

  if (!fpd) return { refs: [...fwdRefs.values()], calls };

  // FPD: reverse the token INPUT string, hash it, search again
  const revResult = await client.searchDoc(pqrHashReversed(token), dataset);
  recordCall('reverse', revResult);
  const revStripped = new Set(parseFilelist(revResult).map(stripTimestamp));

  // Only refs present in BOTH forward AND reverse searches are genuine
  const refs = [...fwdRefs.entries()]
    .filter(([stripped]) => revStripped.has(stripped))
    .map(([, orig]) => orig);

  return { refs, calls };
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
 * @param {boolean} [options.pqr=true] - PQR-hash each token before searching. Set false for
 *   plain/unhashed similarity search — matches records stored with tqnn_store pqr:false.
 *   When false, fpd is forced off regardless of what was passed (no hash to reverse).
 * @param {boolean} [options.parallel=false] - Fire each token's searchToken() call
 *   concurrently (Promise.all) instead of one-at-a-time. Off by default so existing
 *   callers/behaviour are unchanged. Purely a wall-clock optimisation for multi-token
 *   queries — does NOT change which documents match, their scores, or their final
 *   order; per-token accumulation (docScores, docHits, tokenInfo, perTokenTiming) is
 *   still applied in original token order once all calls have settled, so results are
 *   byte-identical to the sequential path. Each token's own forward/reverse (FPD) pair
 *   still runs sequentially within searchToken — only different tokens run concurrently
 *   with each other. NOTE: this increases simultaneous load on the DMM appliance
 *   (up to tokens.length concurrent HTTP calls) — worth a quick check that the target
 *   appliance handles concurrent searchDoc requests cleanly before relying on this in
 *   production, especially on constrained hardware (e.g. the Pi5).
 * @param {boolean} [options.truncate=true] - Slice the above-threshold, sorted match
 *   set down to `maxResults` before returning. Default true preserves existing
 *   behaviour for tqnn_similarity/tqnn_similarity_plain exactly. Callers that need to
 *   apply their own reordering over the FULL above-threshold pool before truncating
 *   (e.g. tqnn_similarity_ranked's citation-shape reranking) should pass false and
 *   truncate the result themselves after reordering — otherwise a downstream reorder
 *   only ever sees whichever arbitrary subset happened to survive this internal slice,
 *   not the true top-N by their own criteria. No extra DMM calls or compute are
 *   introduced by passing false: the full above-threshold set is already accumulated
 *   and sorted internally on every call regardless of `truncate` — this option only
 *   changes whether the tail gets cut here or left for the caller.
 * @returns {Promise<SimilarityResult>}
 */
async function similaritySearch(client, text, {
  threshold = 0.4,
  dataset = '',
  fpd = true,
  maxResults = 20,
  weighted = true,
  pqr = true,
  parallel = false,
  truncate = true
} = {}) {
  const effectiveFpd = pqr ? fpd : false;
  const tokens = tokenise(text);
  if (tokens.length === 0) {
    return {
      tokens_used: [],
      tokens_searched: 0,
      matches_found: 0,
      threshold_pct: threshold * 100,
      weighted,
      pqr,
      fpd: effectiveFpd,
      parallel,
      results: [],
      timing: {
        wall_clock_ms: 0,
        dmm_time_used_total_sec: 0,
        dmm_billing_units_total: 0,
        dmm_calls_made: 0,
        energy: null,
        per_token: []
      },
      message: 'No searchable tokens found in input text.'
    };
  }

  const docScores = new Map();  // canonical_ref (stripped) → weighted score
  const docHits = new Map();    // canonical_ref (stripped) → raw hit count (always tracked, for transparency)
  const tokenInfo = [];         // per-token diagnostics: { token, docCount, weight }
  let searched = 0;
  let totalWeight = 0;          // sum of weights for all successfully searched tokens — denominator for threshold

  // Timing aggregation (v1.5.0) — wall_clock_ms is measured client-side around
  // the whole orchestration loop (so it includes network round-trips AND any
  // client-side processing between calls); dmm_time_used_total_sec sums each
  // individual searchDoc response's self-reported time_used (server-side
  // processing time only, no network). The gap between the two is a rough
  // proxy for network/orchestration overhead vs DMM-side compute.
  const wallClockStart = Date.now();
  let dmmTimeUsedTotal = 0;
  let dmmBillingUnitsTotal = 0;
  let dmmCallsMade = 0;
  let energyKWhTotal = 0;
  let carbonMgTotal = 0;
  let metersDrivenTotal = 0;
  let energyDataSeen = false; // becomes true if ANY call reported energy — older DMM versions may not
  const perTokenTiming = [];

  // Fold one token's already-resolved {refs, calls} into the shared
  // accumulators (docScores, docHits, tokenInfo, perTokenTiming, and the
  // running timing/energy totals). Called in original token order for both
  // the sequential and parallel paths, so output is identical either way —
  // `parallel` only changes when the underlying searchToken() calls are
  // fired relative to each other, never how their results are combined.
  function accumulateToken(token, refs, calls) {
    searched++;
    let tokenTimeUsed = 0;
    for (const c of calls) {
      dmmCallsMade++;
      if (typeof c.time_used === 'number') {
        dmmTimeUsedTotal += c.time_used;
        tokenTimeUsed += c.time_used;
      }
      if (typeof c.billing_units === 'number') dmmBillingUnitsTotal += c.billing_units;
      if (c.energy_usage_kWh !== null) { energyDataSeen = true; energyKWhTotal += c.energy_usage_kWh; }
      if (c.carbon_emissions_mg !== null) { energyDataSeen = true; carbonMgTotal += c.carbon_emissions_mg; }
      if (c.equivalent_meters_driven !== null) { energyDataSeen = true; metersDrivenTotal += c.equivalent_meters_driven; }
    }
    perTokenTiming.push({
      token,
      calls,
      token_time_used_sec: Math.round(tokenTimeUsed * 1000) / 1000
    });

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

  if (parallel) {
    // Fire every token's searchToken() concurrently. A per-token failure
    // still shouldn't abort the whole search, so failures are caught
    // per-promise (not via Promise.all's fail-fast behaviour) and resolved
    // to a sentinel that accumulateToken() below simply skips.
    const settled = await Promise.all(tokens.map(async (token) => {
      try {
        const searchResult = await searchToken(client, token, effectiveFpd, dataset, pqr);
        return { token, ok: true, searchResult };
      } catch (err) {
        process.stderr.write(`[tqnn-similarity] token "${token}" search failed: ${err.message}\n`);
        return { token, ok: false };
      }
    }));

    for (const entry of settled) {
      if (!entry.ok) continue;
      accumulateToken(entry.token, entry.searchResult.refs, entry.searchResult.calls);
    }
  } else {
    for (const token of tokens) {
      let searchResult;
      try {
        searchResult = await searchToken(client, token, effectiveFpd, dataset, pqr);
      } catch (err) {
        // Log and continue — one failed token shouldn't abort the whole search
        process.stderr.write(`[tqnn-similarity] token "${token}" search failed: ${err.message}\n`);
        continue;
      }
      accumulateToken(token, searchResult.refs, searchResult.calls);
    }
  }

  const wallClockMs = Date.now() - wallClockStart;

  const cutoff = totalWeight * threshold;
  const aboveThreshold = [...docScores.entries()]
    .filter(([, score]) => score >= cutoff)
    .sort((a, b) => b[1] - a[1]); // highest weighted score first

  const matched = (truncate ? aboveThreshold.slice(0, maxResults) : aboveThreshold)
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
    total_matches_above_threshold: aboveThreshold.length,
    threshold_pct: threshold * 100,
    weighted,
    pqr,
    fpd: effectiveFpd,
    parallel,
    token_weights: tokenInfo, // per-token doc frequency + weight, for auditability
    timing: {
      wall_clock_ms: wallClockMs,
      dmm_time_used_total_sec: Math.round(dmmTimeUsedTotal * 1000) / 1000,
      dmm_billing_units_total: dmmBillingUnitsTotal,
      dmm_calls_made: dmmCallsMade,
      energy: energyDataSeen ? {
        energy_usage_kWh: energyKWhTotal,
        carbon_emissions_mg: carbonMgTotal,
        equivalent_meters_driven: metersDrivenTotal
      } : null,
      per_token: perTokenTiming
    },
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
