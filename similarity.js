// similarity.js — Multi-call similarity orchestration for TQNN DMM
// TQNN MCP Server v1.9.0
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
//   repeated throughout a domain-specific corpus) could dominate ranking
//   over genuinely discriminating, rarer tokens.
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
//
// v1.7.0 — Optional weightPower exponent (opt-in, default unchanged)
//   Root cause diagnosed 2026-08-11 against three real benchmark failures
//   (a 130-query internal benchmark set): tokenWeight()'s log-dampening
//   is deliberately narrow (a rare token, docCount 1566, only gets weight
//   ~0.094 vs ~0.055-0.068 for generic query words — under 2x spread).
//   Since scores are a plain SUM of matched weights, a document matching
//   6 generic words can and does outscore a document matching 5 words
//   including the one rare, actually-discriminating term — confirmed
//   live: one query's wrong top-1 (missing the rare term) scored 0.381;
//   the real matching document scored 0.357, only 0.024 behind, sitting
//   at rank 3 of 50 rather than 1.
//
//   New optional `weightPower` (default 1 = exact pre-v1.7.0 behaviour,
//   byte-identical output) raises each token's log-dampened weight to
//   this power BEFORE summing, so rarer tokens dominate more heavily
//   relative to common ones. Applied inside tokenWeight() itself, so
//   totalWeight/threshold/overlap_pct — which all derive from the same
//   per-token weight value — stay internally consistent automatically;
//   no other code path needed changing. Verified against real benchmark
//   data: weightPower=2 flips the two documents above (0.0244 vs 0.0264,
//   the real matching doc wins) using the corpus's own real per-token
//   weights, not simulated data.
//
//   NOT yet validated against the full known-good query set or the
//   other two bag-of-tokens failures — that regression pass is the
//   reason this ships opt-in (default 1, old ranking unchanged) rather
//   than replacing the default outright. Intended workflow: run the
//   benchmark twice, once at the default and once with weightPower
//   passed through, and diff.

const crypto = require('crypto');
const { tokenise } = require('./tokeniser');

// ---------------------------------------------------------------------------
// PQR Hashing — Self-Salting scheme, with opt-in Keyed (HMAC) mode (V1.9.0+)
//
// WHAT'S NEW IN V1.9.0: an opt-in `hmac` flag, default FALSE.
//
//   hmac:false (default) — EXACT V1.3.0 behaviour, byte-identical output.
//     Self-salts from the input alone (h1 = SHA256(input)), no key
//     required, no config needed. Every dataset ingested before this
//     version — including an already-running production corpus — keeps
//     working with zero changes. This mode is still a pure, public
//     function of the plaintext: see the security note below before
//     relying on it for anything beyond continuity with existing data.
//
//   hmac:true — folds a secret, per-deployment key (TQNN_PQR_KEY) into
//     both hash steps via HMAC-SHA256 instead of plain SHA256. Requires
//     TQNN_PQR_KEY to be configured; throws (fails closed) if it isn't.
//
// hmac MUST match between store and search, exactly like pqr and fpd
// already have to — hmac:true tokens will never match hmac:false tokens
// for the same input, by design (that's the whole point of adding a key).
//
// WHY hmac:true EXISTS AT ALL — THE SECURITY CASE:
//
// The hmac:false scheme derives its "salt" entirely from the input itself,
// with no secret anywhere in the computation. That makes tqnnToken16() a
// pure, public function of the plaintext: input -> token, fully
// determined, no key material required to compute it. Anyone who knows
// the algorithm (published in the DMMPQR whitepaper, and in this file)
// can:
//
//   1. Take a candidate PII value (a name, a DOB, a government ID number,
//      anything from a breach list or census), run it through the published formula
//      themselves, and check whether the result appears in a stolen token
//      store — no brute-force search of the output space required, no
//      quantum computer required, just a direct, targeted computation.
//   2. Build that lookup table ONCE and reuse it against every DMM
//      deployment on earth, because the same input always produces the
//      same token everywhere — there was nothing deployment-specific in
//      the computation to stop reuse.
//
// This is a classical dictionary attack, not a preimage/brute-force attack,
// so the whitepaper's Grover-cost analysis (scoped to blind inversion of
// the full 64-bit output space) doesn't cover it, and no amount of
// truncation-width or circuit-depth argument changes it. The original
// "self-salting" fix (replacing a constant pad with an input-derived one)
// addressed a DIFFERENT problem — it stopped one precomputed table from
// being reused against a fixed constant pad across deployments — but it
// never introduced a secret, so it never stopped a fresh per-deployment
// dictionary attack computed directly against the published formula.
//
// hmac:true closes that gap by folding a secret, per-deployment key into
// both hash steps. Without the key, an attacker cannot compute a
// candidate's token at all — they would have to recover a full 256-bit
// HMAC key, a completely different and far harder problem than guessing
// a low-entropy PII field.
//
// Algorithm (hmac:true):
//   1. h1     = HMAC-SHA256(key, input)   — 64 hex chars; keyed salt
//   2. mixed  = input + h1                — salt appended to input
//   3. padded = mixed.slice(0, 16)        — first 16 chars
//   4. token  = HMAC-SHA256(key, padded).slice(0, 16)
//
// Algorithm (hmac:false, unchanged from V1.3.0):
//   1. h1     = SHA256(input)             — 64 hex chars; input-derived salt
//   2. mixed  = input + h1                — salt appended to input
//   3. padded = mixed.slice(0, 16)        — first 16 chars
//   4. token  = SHA256(padded).slice(0, 16)
//
// *** MIGRATION PLAN ***
// hmac:false is the default specifically so existing corpora (any
// production dataset already ingested under V1.3.0) keep working with zero
// config while a re-ingest under hmac:true is scheduled. Once re-ingested,
// flip the calling side's default to hmac:true (tqnn_search/tqnn_similarity/
// tqnn_store) so new writes and reads use the keyed scheme going forward.
// Until then, hmac:false carries the same dictionary-attack exposure
// described above — it is a continuity bridge, not a fix, and shouldn't be
// treated as the end state.
//
// *** ALSO CHECK ***
// This file's original V1.3.0 header claimed the algorithm "mirrors
// storeDoc.php / tqnn_dmm_ide.html exactly" — i.e. at least two other
// codebases (the DMM appliance's PHP backend, and the Workbench IDE's
// browser-side JS) may independently reimplement this same hash chain.
// CONFIRM whether either does its own PQR hashing server-/tool-side. If
// so, both need the same hmac:true option and the same key, or tokens
// computed through those paths will silently diverge from tokens computed
// here — a mismatch that would surface only as "no results", with no
// error message pointing at the real cause.
// ---------------------------------------------------------------------------

let _pqrKeyCache = null;

/**
 * Resolve the PQR HMAC key from TQNN_PQR_KEY (env), cached after first
 * successful read. Only ever called when hmac:true.
 *
 * Deliberately fails closed: if no key (or too short a key) is configured,
 * this throws rather than silently falling back to hmac:false. Falling
 * back automatically would mean a caller who explicitly asked for hmac:true
 * could be silently downgraded to the precomputable scheme without knowing
 * it — the point of an explicit flag is that the caller's choice is
 * honoured or the call fails, never quietly substituted.
 *
 * @returns {Buffer}
 */
function getPqrKey() {
  if (_pqrKeyCache) return _pqrKeyCache;
  const raw = process.env.TQNN_PQR_KEY || '';
  if (raw.length < 32) {
    throw new Error(
      'TQNN_PQR_KEY is missing or too short (need ≥ 32 chars). hmac:true requires a ' +
      'per-deployment secret key and will not silently fall back to hmac:false. ' +
      'Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"\n' +
      'and set TQNN_PQR_KEY=<value> in .env — or pass hmac:false (or omit hmac) to use ' +
      'the existing unkeyed scheme against already-ingested data.'
    );
  }
  _pqrKeyCache = Buffer.from(raw, 'utf8');
  return _pqrKeyCache;
}

/**
 * Self-Salting PQR token. hmac:false (default) is byte-identical to the
 * original V1.3.0 scheme — no key needed, matches any data already
 * ingested under it. hmac:true folds in a secret per-deployment key via
 * HMAC-SHA256 — see the header note above for why, and for the migration
 * plan from one to the other.
 * @param {string} s - Input token (will be trimmed)
 * @param {object} [opts]
 * @param {boolean} [opts.hmac=false] - Use the keyed construction.
 * @param {Buffer|string} [opts.key] - HMAC key override (else TQNN_PQR_KEY
 *   from env via getPqrKey()). Only read when hmac:true. Exposed mainly so
 *   tests can pass a fixed key without touching process.env.
 * @returns {string} 16-char hex token
 */
function tqnnToken16(s, { hmac = false, key } = {}) {
  const input = String(s).trim();

  if (!hmac) {
    // Unkeyed V1.3.0 scheme — unchanged, no key required.
    const h1     = crypto.createHash('sha256').update(input, 'utf8').digest('hex');
    const mixed  = input + h1;
    const padded = mixed.slice(0, 16);
    return crypto.createHash('sha256').update(padded, 'utf8').digest('hex').slice(0, 16);
  }

  const hmacKey = key || getPqrKey();
  const h1       = crypto.createHmac('sha256', hmacKey).update(input, 'utf8').digest('hex');
  const mixed    = input + h1;
  const padded   = mixed.slice(0, 16);
  return crypto.createHmac('sha256', hmacKey).update(padded, 'utf8').digest('hex').slice(0, 16);
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
 * @param {boolean} [hmac=false] - See tqnnToken16().
 * @returns {string} 16-char hex token
 */
function pqrHash(token, hmac = false) {
  return tqnnToken16(token, { hmac });
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
 *
 * Note: FPD is a false-positive-rate / precision feature (it filters out
 * 64-bit truncation collisions), not a security control — reversing a
 * candidate string is exactly as cheap for an attacker as hashing it
 * forwards, so this does not raise attack cost either way. hmac:true is
 * what raises attack cost; FPD does not.
 * @param {string} token
 * @param {boolean} [hmac=false] - See tqnnToken16().
 * @returns {string} 16-char hex token
 */
function pqrHashReversed(token, hmac = false) {
  return tqnnToken16(token.split('').reverse().join(''), { hmac });
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
 * v1.7.0 — optional `power` exponent, default 1 (exact prior behaviour,
 * unchanged). Raising the log-dampened weight to a power >1 before it
 * gets summed with other tokens' weights makes rare/high-value tokens
 * dominate more over several common-word matches — see the v1.7.0 header
 * note above for the real benchmark case this targets. docCount=0's
 * weight of exactly 1 is unaffected by any power (1^n = 1), so the
 * "effectively required" threshold behaviour for a totally-absent token
 * is preserved at every power value.
 *
 * @param {number} docCount - Number of documents this token matched
 * @param {number} [power=1] - Exponent applied to the log-dampened weight
 *   before it is used. 1 = unchanged pre-v1.7.0 behaviour. >1 sharpens
 *   the gap between rare and common tokens.
 * @returns {number} weight, always > 0
 */
function tokenWeight(docCount, power = 1) {
  const base = 1 / Math.log2(Math.max(docCount, 0) + 2);
  return power === 1 ? base : Math.pow(base, power);
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
 * @param {boolean} [hmac=false] - Use the keyed HMAC PQR construction instead of the unkeyed
 *   V1.3.0 scheme. Ignored when pqr:false. Must match how the target record was stored.
 * @returns {Promise<{refs: string[], calls: Array<{pass: string, time_used: number|null, billing_units: number|null, fc: number|null}>}>}
 *   refs: original filereference strings (with timestamp), same as pre-v1.5.0's bare return.
 *   calls: one entry per DMM searchDoc call actually made for this token (1 normally, 2 under FPD).
 */
async function searchToken(client, token, fpd, dataset, pqr = true, hmac = false) {
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

  const fwdResult = await client.searchDoc(pqrHash(token, hmac), dataset);
  recordCall('forward', fwdResult);
  const fwdRefs = new Map(); // stripped → original
  for (const ref of parseFilelist(fwdResult)) {
    fwdRefs.set(stripTimestamp(ref), ref);
  }

  if (!fpd) return { refs: [...fwdRefs.values()], calls };

  // FPD: reverse the token INPUT string, hash it, search again
  const revResult = await client.searchDoc(pqrHashReversed(token, hmac), dataset);
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
 * @param {number} [options.weightPower=1] - Exponent applied to each token's
 *   log-dampened IDF weight (see tokenWeight()) before it is summed into a
 *   document's score. 1 = exact pre-v1.7.0 behaviour, byte-identical output.
 *   Values >1 (e.g. 2) let rare/high-value tokens dominate more heavily over
 *   several common-word matches — opt-in prototype for the bag-of-tokens
 *   ranking failures diagnosed 2026-08-11 against a 130-query internal
 *   benchmark set. Also affects totalWeight and therefore overlap_pct and
 *   the threshold cutoff, consistently — all three derive from the same
 *   per-token weight value, so nothing needed separate handling.
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
 * @param {boolean} [options.caseInsensitive=false] - False (default) = exact
 *   pre-v1.8.0 behaviour, byte-identical output: every token in `tokens_used`
 *   is scored as its own fully independent requirement. When true, tokens
 *   that differ only by case (e.g. "imaging" and "Imaging" — as produced by
 *   a client deliberately sending both case forms of a word, since PQR
 *   hashing is case-sensitive at the storage layer and each casing lives in
 *   its own hash bucket) are grouped by lowercase form BEFORE weighting.
 *   Each token in a group is still individually searched against DMM
 *   exactly as before (no change to what gets searched or how many DMM
 *   calls are made — see per-variant entries still present in
 *   `timing.per_token`) but their matched-document sets are UNIONED into
 *   one merged set, and ONE weight is computed from that merged set's size
 *   (not one weight per case form). A document that matched only one
 *   casing, or both, is credited with that single group weight exactly
 *   once — never double-counted, and never required to match every case
 *   form to get full credit. This also incidentally fixes the "phantom
 *   token" failure mode where a duplicated case form exists nowhere in the
 *   corpus (docCount 0, weight forced to 1 — see tokenWeight()'s docCount=0
 *   note): merged into a group with a real variant, the union simply
 *   equals the real variant's own doc set, so no permanently-unmatchable
 *   weight gets baked into totalWeight. Diagnosed 2026-08-14 against a set
 *   of benchmark queries where round-2 case-duplication (sending both case
 *   forms as independent tokens, no merge) regressed to zero results
 *   despite round-1 (no duplication) returning full result sets — see
 *   dmm-round2-tuning notes.
 * @returns {Promise<SimilarityResult>}
 */
async function similaritySearch(client, text, {
  threshold = 0.4,
  dataset = '',
  fpd = true,
  maxResults = 20,
  weighted = true,
  pqr = true,
  hmac = false,
  parallel = false,
  truncate = true,
  weightPower = 1,
  caseInsensitive = false
} = {}) {
  // v1.9.0 — fail fast on a missing/invalid PQR key, ONCE, up front, but
  // ONLY when hmac:true was actually requested. hmac defaults to false, so
  // by default this never fires and existing data (ingested under the
  // unkeyed V1.3.0 scheme, e.g. an already-loaded production corpus) keeps
  // working with zero config.
  //
  // Without this eager check, a missing key on an hmac:true call would
  // manifest as tqnnToken16() throwing deep inside searchToken(), which is
  // called from inside a catch-and-continue loop below (both the sequential
  // and parallel branches log the error to stderr and skip that token
  // rather than propagating it). That means the caller would just see
  // "0 tokens matched" / an empty result set — a confusing "no results"
  // failure mode with no indication the real cause was a missing key, not
  // an empty corpus. Checking here instead lets the error reach the MCP
  // tool handler's own try/catch in index.js and come back to the caller
  // as a clear, single error message.
  if (pqr && hmac) getPqrKey();

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
      hmac,
      fpd: effectiveFpd,
      parallel,
      weight_power: weightPower,
      case_insensitive: caseInsensitive,
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
    const weight = weighted ? tokenWeight(docCount, weightPower) : 1;
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

  // Fold a GROUP of case-variant tokens (e.g. [{token:'imaging',...},
  // {token:'Imaging',...}]) into the shared accumulators as ONE merged
  // requirement, rather than one independent requirement per variant.
  // Only used when caseInsensitive:true. Per-variant search/timing/billing
  // bookkeeping is identical to accumulateToken (each variant's own DMM
  // call(s) are still logged individually in perTokenTiming) — what
  // differs is that docCount/weight/totalWeight/docScores/docHits are all
  // computed ONCE from the UNION of every variant's matched documents,
  // never per-variant. A document matching any variant (or several) is
  // credited with the group's single weight exactly once.
  function accumulateGroup(variants) {
    const mergedRefs = new Map(); // stripped key -> original ref (first-seen wins)
    const variantDiagnostics = [];

    for (const { token, refs, calls } of variants) {
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
      variantDiagnostics.push({ token, docCount: refs.length });

      for (const ref of refs) {
        const key = stripTimestamp(ref);
        if (!mergedRefs.has(key)) mergedRefs.set(key, ref);
      }
    }

    const docCount = mergedRefs.size; // size of the UNION — the merged, "case-insensitive" doc count
    const weight = weighted ? tokenWeight(docCount, weightPower) : 1;
    totalWeight += weight; // added ONCE per group, not once per variant

    tokenInfo.push({
      token: variants.length > 1 ? variants.map(v => v.token).join('/') : variants[0].token,
      docCount,
      weight: Math.round(weight * 1000) / 1000,
      // Per-variant doc counts before the merge, so it's still visible how
      // much (if anything) each individual casing contributed — omitted
      // entirely for singleton groups so output for ordinary, non-case-
      // duplicated tokens is unchanged.
      ...(variants.length > 1 ? { variants: variantDiagnostics } : {})
    });

    for (const key of mergedRefs.keys()) {
      docScores.set(key, (docScores.get(key) || 0) + weight);
      docHits.set(key, (docHits.get(key) || 0) + 1); // +1 per merged CONCEPT matched, not per variant
    }
  }

  // Every token is still searched individually against DMM exactly as
  // before — caseInsensitive only changes how results get FOLDED into the
  // accumulators afterward, never what gets searched or how many DMM calls
  // are made. So the search step always collects one {token, refs, calls}
  // result per token first; only the folding step below branches.
  const perTokenResults = []; // in original tokens order; entries with failed searches are simply absent

  if (parallel) {
    // Fire every token's searchToken() concurrently. A per-token failure
    // still shouldn't abort the whole search, so failures are caught
    // per-promise (not via Promise.all's fail-fast behaviour) and resolved
    // to a sentinel that's simply skipped below.
    const settled = await Promise.all(tokens.map(async (token) => {
      try {
        const searchResult = await searchToken(client, token, effectiveFpd, dataset, pqr, hmac);
        return { token, ok: true, searchResult };
      } catch (err) {
        process.stderr.write(`[tqnn-similarity] token "${token}" search failed: ${err.message}\n`);
        return { token, ok: false };
      }
    }));

    for (const entry of settled) {
      if (!entry.ok) continue;
      perTokenResults.push({ token: entry.token, refs: entry.searchResult.refs, calls: entry.searchResult.calls });
    }
  } else {
    for (const token of tokens) {
      let searchResult;
      try {
        searchResult = await searchToken(client, token, effectiveFpd, dataset, pqr, hmac);
      } catch (err) {
        // Log and continue — one failed token shouldn't abort the whole search
        process.stderr.write(`[tqnn-similarity] token "${token}" search failed: ${err.message}\n`);
        continue;
      }
      perTokenResults.push({ token, refs: searchResult.refs, calls: searchResult.calls });
    }
  }

  if (caseInsensitive) {
    // Group by lowercase form, preserving first-seen group order, then
    // fold each group as ONE merged requirement. A group of size 1 (a
    // token with no case-variant partner in this query) behaves exactly
    // like accumulateToken would have — union-of-one-set is just that
    // set, so ordinary non-duplicated tokens see no change in scoring.
    const groups = new Map(); // lowercase key -> array of {token, refs, calls}, in first-seen order
    for (const r of perTokenResults) {
      const key = r.token.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const variants of groups.values()) {
      accumulateGroup(variants);
    }
  } else {
    // Default path — byte-identical to pre-v1.8.0 behaviour: every token
    // is its own fully independent requirement, folded in original order.
    for (const r of perTokenResults) {
      accumulateToken(r.token, r.refs, r.calls);
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
    hmac,
    fpd: effectiveFpd,
    parallel,
    weight_power: weightPower, // 1 = pre-v1.7.0 behaviour; see tokenWeight() header note
    case_insensitive: caseInsensitive, // false = pre-v1.8.0 behaviour; see accumulateGroup() header note
    token_weights: tokenInfo, // per-token (or, when case_insensitive:true, per-merged-group) doc frequency + weight, for auditability
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
  getPqrKey,
  searchToken,
  parseFilelist,
  stripTimestamp,
  tokenise,
  tokenWeight
};
