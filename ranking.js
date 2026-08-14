// ranking.js — Citation-shape tie-breaking for tqnn_similarity results
// TQNN MCP Server — new module, added alongside similarity.js
//
// Background: tqnn_similarity's IDF-weighted scoring is presence/absence
// per token, per document. Once a document contains every searched token
// it hits the scoring ceiling — so on queries where many documents fully
// match (common on short, specific clinical queries), a large group of
// results can tie exactly. Manual investigation against the Radiology
// corpus found the tied group routinely mixes genuine prose with
// bibliography/citation-list chunks that happen to contain all the same
// tokens scattered across unrelated citation entries.
//
// Term frequency and length-normalized frequency were both tested against
// real tied chunks and did NOT separate the two cleanly (citation lists
// repeat domain words across many citation titles, so raw/normalized
// frequency actually favours them in some cases). Three simple surface
// statistics DID separate cleanly with no overlap across the tested
// sample:
//   dd  = digit density (%)             — years, page/volume numbers
//   cwr = capitalized-word ratio (%)     — author-initial-style capitals
//   pd  = punctuation density (%)        — citation punctuation patterns
// (Shannon word entropy was also computed but did not separate the two
// groups — citation lists are lexically rich, not repetitive — so it is
// carried through as data (`ent`) but not used in scoring here.)
//
// This module does NOT change tqnn_similarity or DMM in any way. It is a
// separate, optional, client-side lookup consulted only by the new
// tqnn_similarity_ranked tool, after similaritySearch() has already run
// and returned its (possibly tied) results.
//
// V1.6.1 — Fixed a stack overflow on very high-frequency single-token
//   queries. applyCitationShapeRanking() previously used
//   `reranked.push(...distinct, ...duplicates, ...withoutScore)` —
//   spreading array elements into a function call, which V8 caps by
//   argument count (independent of normal array-size limits). A
//   single-token query on a common word (e.g. "imaging", 514,399 matches
//   in the Radiology dataset) makes every matching chunk tie on
//   weighted_score (there is only one token's weight to sum), so the
//   entire result set becomes ONE tie group — and spreading a 514k-element
//   array into push() blew the argument-count ceiling with "Maximum call
//   stack size exceeded". Confirmed via live 500/crash on the appliance,
//   then reproduced exactly (byte-identical error message) at N=514,399 in
//   isolation. Fixed by replacing the three spread-pushes with plain
//   loops, which have no such limit at any array size. Multi-token queries
//   were never affected — tie groups there are naturally bounded by how
//   many chunks can share one exact combined score across several tokens,
//   which stays far below V8's argument-count ceiling in practice.
//   applySourceCap()'s `[...kept, ...deferred]` (array-LITERAL spread, a
//   different and safe construct — no argument-count limit applies)
//   confirmed unaffected and left as-is.
//
// Ranking data is precomputed OFFLINE per dataset by
// build_shard_ranking_metadata.py, run once against a dataset's corpus
// shards. Output is a flat, pipe-delimited file:
//     chunk_id|dd|cwr|pd|ent|source_id|is_figure
// (source_id added — see applySourceCap() below — a short hash of the
// chunk's source document, used to cap how many chunks from one document
// can occupy a result set. Older .rank files without a 6th field still
// parse fine; source_id is simply undefined for those rows, and
// applySourceCap() treats any result with no source_id as ungroupable
// and passes it through uncapped.)
//
// V2 (2026-08-13) — is_figure added as an optional 7th field: "1" if this
// chunk's title matched the "Figure N - ..." pattern at build time (see
// build_shard_ranking_metadata.py's own V2 notes), "0" otherwise.
// Confirmed live against 5 real chunks across 2 independent papers: every
// Figure-titled chunk found was low-value (truncated caption, garbled
// OCR fragment, or no caption at all) versus the same paper's other
// chunks. Same file also fixed a real source_id bug found the same day —
// source_id used to hash the raw per-chunk title, but title varies
// chunk-to-chunk (every figure chunk has its own distinct truncated
// title), so a paper's figure chunks previously got a DIFFERENT
// source_id from its own real chunks — meaning applySourceCap() could
// not recognize them as the same source it was already correctly capping
// everything else from. Older 5/6-field .rank files still parse fine;
// is_figure simply comes back undefined for those rows. Attached to
// every result for auditability the same way citation_shape/source_id
// already are — NOT yet consumed by any reordering/demotion logic here.
// Whether and how to act on is_figure (tie-scoped score adjustment like
// citation_shape, or a whole-list pass like applySourceCap, or something
// else) is a separate, not-yet-decided design question — see
// dmm-round2-tuning notes, 2026-08-13.
//
// stored per-dataset (this deployment model is one MCP server instance
// per user/dataset, so there is normally at most one ranking file
// relevant to a given running server — but the loader is dataset-keyed
// regardless, in case that changes). Ranking is niche/optional: most
// datasets will have NO ranking file, and every function here degrades
// gracefully to "ranking not available" rather than erroring.

const fs = require('fs');
const path = require('path');

// Directory containing per-dataset ranking files, named "<dataset>.rank".
// Matches the existing base_path convention already used for local_jsonl
// resolvers in tqnn_resolvers.json (e.g. "/home/tqnn/data/"). Override via
// TQNN_RANKING_DIR if a given deployment's layout differs.
const RANKING_DIR = process.env.TQNN_RANKING_DIR || '/home/tqnn/data/ranks';

// dataset -> { mtimeMs, table: Map<chunk_id, {dd,cwr,pd,ent}> }
const _rankingCache = new Map();

/**
 * Dataset names flow directly into a filename here (unlike normal DMM
 * calls, which pass dataset through to the appliance/tqnn_resolvers.json
 * scheme lookup). Keep this narrow — alnum, underscore, hyphen only — so
 * a dataset value can never escape RANKING_DIR.
 * @param {string} dataset
 * @returns {boolean}
 */
function isSafeDatasetName(dataset) {
  return typeof dataset === 'string' && /^[a-zA-Z0-9_-]+$/.test(dataset);
}

/**
 * Parse one line of a .rank file into a metadata object. Accepts the
 * original 5-field format (chunk_id|dd|cwr|pd|ent), the 6-field format
 * with source_id appended, and the newer 7-field format with is_figure
 * also appended — so a server can be pointed at an older .rank file
 * without regenerating it, and any field added after this file's own
 * data doesn't exist for those rows simply comes back undefined rather
 * than erroring.
 * @param {string} line - "chunk_id|dd|cwr|pd|ent", "...|source_id", or "...|source_id|is_figure"
 * @returns {{chunk_id: string, dd: number, cwr: number, pd: number, ent: number, source_id: string|undefined, is_figure: boolean|undefined} | null}
 */
function parseRankLine(line) {
  const parts = line.split('|');
  if (parts.length < 5 || parts.length > 7) return null;
  const [chunk_id, dd, cwr, pd, ent, source_id, is_figure] = parts;
  return {
    chunk_id,
    dd: parseFloat(dd),
    cwr: parseFloat(cwr),
    pd: parseFloat(pd),
    ent: parseFloat(ent),
    source_id: source_id || undefined,
    is_figure: is_figure === undefined ? undefined : is_figure === '1'
  };
}

/**
 * Load (and cache) the ranking table for a dataset. Returns null — never
 * throws — if no ranking file exists for this dataset, so callers can
 * treat "no ranking data" as a normal, expected case rather than an error.
 * Cache is invalidated on file mtime change, matching the pattern already
 * used for tqnn_mcp_credentials.json in index.js.
 * @param {string} dataset
 * @returns {Map<string, {dd:number,cwr:number,pd:number,ent:number,source_id:string|undefined,is_figure:boolean|undefined}> | null}
 */
function loadRankingTable(dataset) {
  if (!dataset || !isSafeDatasetName(dataset)) return null;

  const filePath = path.join(RANKING_DIR, `${dataset}.rank`);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null; // no ranking file for this dataset — expected/common case
  }

  const cached = _rankingCache.get(dataset);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.table;
  }

  const table = new Map();
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseRankLine(trimmed);
    if (parsed) table.set(parsed.chunk_id, parsed);
  }

  _rankingCache.set(dataset, { mtimeMs: stat.mtimeMs, table });
  return table;
}

/**
 * A tqnn_similarity filereference is stripTimestamp()'d to "chunk_id::" —
 * recover the bare chunk_id to look up in the ranking table.
 * @param {string} filereference - e.g. "459938591688393262::"
 * @returns {string}
 */
function filereferenceToChunkId(filereference) {
  return filereference.endsWith('::') ? filereference.slice(0, -2) : filereference;
}

/**
 * Combine dd/cwr/pd into a single citation-shape score. Higher = more
 * citation-list-like (bibliography), lower = more like genuine prose.
 * Simple unweighted sum of the three percentages — a reasonable first cut
 * given all three showed a clean ~2x gap independently in initial testing.
 * NOT yet calibrated against a large labelled sample — revisit the
 * combination/weights once more bibliography examples have been checked
 * against this scoring (see dmm-similarity-ranking-improvements notes).
 * @param {{dd:number,cwr:number,pd:number}} entry
 * @returns {number}
 */
function citationShapeScore(entry) {
  return entry.dd + entry.cwr + entry.pd;
}

/**
 * Build a key that is identical for two entries if and only if their
 * dd/cwr/pd/ent are all identical. Since these four stats are computed
 * deterministically FROM the chunk's raw text (see the offline
 * build_shard_ranking_metadata.py step), an exact match on all four is
 * strong evidence the underlying chunk text is byte-identical — this is
 * NOT a semantic/near-duplicate check, only exact-duplicate detection
 * (e.g. the same source PDF ingested twice under different filenames).
 * A near-duplicate (paraphrased, or a different excerpt of the same
 * paper) will differ on at least one of these four values and will NOT
 * be caught here — deliberately conservative, to avoid false positives
 * suppressing genuinely distinct content.
 * @param {{dd:number,cwr:number,pd:number,ent:number}} shape
 * @returns {string}
 */
function exactDuplicateKey(shape) {
  return `${shape.dd}|${shape.cwr}|${shape.pd}|${shape.ent}`;
}

/**
 * Re-order a tqnn_similarity result set using citation-shape data, WITHOUT
 * changing which documents are included or their primary IDF-weighted
 * ranking. Only reorders WITHIN groups of results that share the exact
 * same weighted_score (i.e. only breaks ties) — a document that already
 * scored higher on IDF weighting is never outranked by a lower-IDF
 * document just because it has a better citation-shape score. This keeps
 * the augmentation strictly additive and bounded: it cannot make the
 * underlying similarity search's threshold/inclusion decisions worse,
 * only refine ordering within an otherwise-undifferentiated tie.
 *
 * Within a tie group, exact-duplicate chunks (identical dd/cwr/pd/ent —
 * see exactDuplicateKey) are additionally pushed behind every distinct
 * chunk in that group, keeping only the first (lowest citation-shape
 * score) copy of each duplicate cluster in its natural position. Nothing
 * is removed from the result set — a duplicate copy still appears, just
 * later — so this only "frees a slot" in the sense that a caller who then
 * truncates to max_results (as tqnn_similarity_ranked does) will prefer
 * one representative per distinct chunk before spending a slot on a
 * second copy of one already seen. Each duplicate copy is tagged with
 * `duplicate_of` (the chunk_id of the kept first occurrence) so this is
 * auditable rather than silent.
 *
 * Every result gets its citation-shape data attached (or null if
 * unavailable for that chunk) for auditability, regardless of whether
 * reordering happened.
 *
 * @param {object[]} results - similaritySearch()'s `results` array
 * @param {string} dataset
 * @returns {{ results: object[], ranking_available: boolean }}
 */
function applyCitationShapeRanking(results, dataset) {
  const table = loadRankingTable(dataset);
  const ranking_available = table !== null;

  const augmented = results.map(r => {
    const chunkId = filereferenceToChunkId(r.filereference);
    const entry = ranking_available ? table.get(chunkId) : undefined;
    if (!entry) {
      return { ...r, citation_shape: null, source_id: null, is_figure: null };
    }
    return {
      ...r,
      citation_shape: {
        dd: entry.dd,
        cwr: entry.cwr,
        pd: entry.pd,
        ent: entry.ent,
        score: Math.round(citationShapeScore(entry) * 1000) / 1000
      },
      source_id: entry.source_id || null,
      // Surfaced for auditability, same as citation_shape/source_id above —
      // NOT currently consumed by the reordering below. Whether/how to act
      // on it is a separate, not-yet-decided design question.
      is_figure: entry.is_figure === undefined ? null : entry.is_figure
    };
  });

  if (!ranking_available) {
    return { results: augmented, ranking_available: false };
  }

  // Group consecutive-by-score results (input is already sorted by
  // weighted_score descending) and re-sort only within each tie group by
  // ascending citation_shape.score (lower = more prose-like = preferred).
  // Results with no citation_shape data (chunk not in the ranking table)
  // are left in their original relative position within the tie group,
  // sorted after any results that DO have data — we have no basis to
  // prefer or penalise them, so don't guess.
  const reranked = [];
  let i = 0;
  while (i < augmented.length) {
    let j = i + 1;
    while (j < augmented.length && augmented[j].weighted_score === augmented[i].weighted_score) {
      j++;
    }
    const tieGroup = augmented.slice(i, j);
    if (tieGroup.length > 1) {
      const withScore = tieGroup.filter(r => r.citation_shape !== null);
      const withoutScore = tieGroup.filter(r => r.citation_shape === null);
      withScore.sort((a, b) => a.citation_shape.score - b.citation_shape.score);

      // Exact-duplicate split: first occurrence of each dd/cwr/pd/ent key
      // stays in its sorted position; repeat occurrences are collected
      // separately and appended after every distinct chunk in this group.
      const seenKeys = new Map(); // key -> chunk_id of the kept first occurrence
      const distinct = [];
      const duplicates = [];
      for (const r of withScore) {
        const key = exactDuplicateKey(r.citation_shape);
        const firstChunkId = seenKeys.get(key);
        if (firstChunkId === undefined) {
          seenKeys.set(key, filereferenceToChunkId(r.filereference));
          distinct.push({ ...r, duplicate_of: null });
        } else {
          duplicates.push({ ...r, duplicate_of: firstChunkId });
        }
      }

      // Append distinct/duplicate/no-data results to the running output.
      // NOTE (V1.6.1): previously `reranked.push(...distinct, ...duplicates,
      // ...withoutScore)`. That spreads every element as an individual
      // argument to push() — fine for a normal tie group, but for a
      // single-token query on a very high-frequency word (e.g. "imaging",
      // 514k+ matches — every matching chunk ties on weighted_score since
      // there's only one token's weight to sum, so the ENTIRE result set
      // becomes one tie group), that blows V8's function-call argument
      // limit with "Maximum call stack size exceeded". A plain loop has no
      // such limit — it's identical at any size, normal or huge, so there's
      // no reason to keep the spread form even for the common case.
      for (const r of distinct) reranked.push(r);
      for (const r of duplicates) reranked.push(r);
      for (const r of withoutScore) reranked.push(r);
    } else {
      reranked.push({ ...tieGroup[0], duplicate_of: null });
    }
    i = j;
  }

  return { results: reranked, ranking_available: true };
}

/**
 * Cap how many results from any single source document (by source_id) can
 * appear before others are pushed behind them — addressing a distinct
 * problem from exact-duplicate suppression above: even with zero
 * byte-identical chunks, a single large/thorough paper can legitimately
 * out-score enough of its own chunks to fill most of a result set (e.g.
 * observed 2026-08-07: one paper alone took 4 of 10 slots on
 * staging_01/clinical_decision_08, all ~90-100% topically relevant, just
 * heavily concentrated in one source with overlapping adjacent chunks).
 *
 * Unlike the tie-group-scoped exact-duplicate handling in
 * applyCitationShapeRanking(), this cap is applied across the WHOLE
 * result list in its already-reranked order (call this AFTER
 * applyCitationShapeRanking, before truncating to max_results) — the
 * over-concentration this addresses isn't confined to a single tied
 * score group.
 *
 * Same non-destructive design as the exact-duplicate fix: nothing is
 * removed. Results kept under the cap stay in their existing order;
 * results that would exceed the cap for their source_id are moved behind
 * every kept result (preserving their relative order among themselves)
 * and tagged `source_capped: true`, so a caller with a large enough
 * max_results still sees them, and the effect is auditable rather than
 * silent. Results with no source_id (missing ranking data, or an older
 * 5-field .rank file — see parseRankLine) are never capped, since there
 * is no basis to group them with anything.
 *
 * @param {object[]} results - Output of applyCitationShapeRanking's `results`
 *   (each entry already carries `source_id`, or null/undefined if unavailable)
 * @param {number} [maxPerSource=0] - Max results allowed per source_id.
 *   0 or falsy = uncapped, returns results unchanged (with source_capped:false
 *   tagged on every entry for a consistent shape) — this is the default, so
 *   existing callers that don't pass max_per_source see no behaviour change.
 * @returns {object[]}
 */
function applySourceCap(results, maxPerSource = 0) {
  if (!maxPerSource || maxPerSource <= 0) {
    return results.map(r => ({ ...r, source_capped: false }));
  }

  const counts = new Map(); // source_id -> count kept so far
  const kept = [];
  const deferred = [];

  for (const r of results) {
    if (!r.source_id) {
      kept.push({ ...r, source_capped: false });
      continue;
    }
    const count = counts.get(r.source_id) || 0;
    if (count < maxPerSource) {
      counts.set(r.source_id, count + 1);
      kept.push({ ...r, source_capped: false });
    } else {
      deferred.push({ ...r, source_capped: true });
    }
  }

  return [...kept, ...deferred];
}

/**
 * Push every result where is_figure===true behind every result where it
 * isn't, preserving relative order within each group. Same non-destructive
 * shape as applySourceCap() above: nothing removed, nothing re-scored —
 * just a partition, tagged for auditability (`figure_demoted`) so a caller
 * with a large enough max_results still sees figure chunks, and the effect
 * is visible rather than silent.
 *
 * Deliberately a hard partition rather than a scoring adjustment folded
 * into citationShapeScore: citation_shape's dd/cwr/pd were built to detect
 * bibliography shape, not figure-caption shape, and only ever reorders
 * WITHIN an exact weighted_score tie — a figure chunk that happens to pack
 * in several exact query tokens densely could otherwise outright outscore
 * a real prose chunk, which citation-shape reranking would never touch.
 * This runs across the whole list regardless of ties, same as
 * applySourceCap does for source concentration.
 *
 * Results with is_figure null/undefined (no ranking data for that chunk,
 * or an older .rank file without the 7th field) are treated as "not a
 * figure" — never demoted — since there's no basis to demote without a
 * positive is_figure:true.
 *
 * @param {object[]} results - Output of applyCitationShapeRanking's `results`
 *   (each entry already carries `is_figure`, or null if unavailable)
 * @param {boolean} [demoteFigures=false] - false (default) = returns results
 *   unchanged (with figure_demoted:false tagged on every entry for a
 *   consistent shape) — existing callers see no behaviour change.
 * @returns {object[]}
 */
function applyFigureDemotion(results, demoteFigures = false) {
  if (!demoteFigures) {
    return results.map(r => ({ ...r, figure_demoted: false }));
  }

  const kept = [];
  const deferred = [];
  for (const r of results) {
    if (r.is_figure === true) {
      deferred.push({ ...r, figure_demoted: true });
    } else {
      kept.push({ ...r, figure_demoted: false });
    }
  }
  return [...kept, ...deferred];
}

// ---------------------------------------------------------------------------
// Aboutness — paper-level topic-overlap soft demotion (added 2026-08-14)
// ---------------------------------------------------------------------------
//
// Built from a completely separate offline index (build_aboutness_index.py
// — see that script's header for the full design rationale) that groups
// non-figure chunks by source_id (the SAME source_id already used by
// applySourceCap/applyFigureDemotion above — deliberately read from the
// same loadRankingTable() rather than recomputed, so the join always
// lines up) and concatenates each paper's per-chunk AI-generated preamble
// sentences into one token set per paper.
//
// Multiplicative-only demotion, never a boost: a paper whose preamble
// tokens overlap heavily with the query's tokens keeps its weighted_score
// essentially unchanged (factor -> 1.0); a paper with little/no overlap
// gets scaled down toward `floor`, never below it, and NEVER excluded —
// same non-destructive philosophy as figure-demotion/source-capping.
// Deliberately NOT additive (unlike weight_power, which can amplify a
// document upward and — per the 2026-08-11 testing — fixed anatomy_06
// while regressing dose_06 and worsening guideline_10 in the same
// change). A pure demotion factor can only ever make a wrong-topic paper
// LESS competitive, never make any paper MORE competitive than its own
// honest weighted_score — bounded, one-directional risk.
//
// Runs BEFORE applyCitationShapeRanking (establishes the primary sort
// order; citation-shape then still tie-breaks WITHIN whatever comes out
// tied on weighted_score, which is left untouched — only a separate
// adjusted score is used for the aboutness sort itself, for auditability).

const ABOUTNESS_DIR = process.env.TQNN_ABOUTNESS_DIR || '/home/tqnn/data/aboutness';

// dataset -> { mtimeMs, ids: string[], offsets: number[], lengths: number[], fd: number }
const _aboutnessIndexCache = new Map();

/**
 * Loads (and caches) the small sorted byte-offset index for a dataset's
 * aboutness data — NOT the token data itself, which stays on disk and is
 * only ever read one paper at a time via getPaperAboutnessTokens(). This
 * keeps memory bounded by (unique papers x ~20 bytes/index-row), not by
 * corpus size or total token volume — the same reason build_chunk_index.py
 * /chunk-index.js use a byte-offset index rather than loading everything.
 * Returns null — never throws — if no aboutness index exists for this
 * dataset, so callers degrade gracefully to "aboutness not available".
 * @param {string} dataset
 * @returns {{ids: string[], offsets: number[], lengths: number[], fd: number} | null}
 */
function loadAboutnessIndex(dataset) {
  if (!dataset || !isSafeDatasetName(dataset)) return null;

  const indexPath = path.join(ABOUTNESS_DIR, `aboutness_${dataset}_index.tsv`);
  const tokensPath = path.join(ABOUTNESS_DIR, `aboutness_${dataset}.jsonl`);
  let stat;
  try {
    stat = fs.statSync(indexPath);
  } catch {
    return null; // no aboutness index built for this dataset yet — expected/common case
  }

  const cached = _aboutnessIndexCache.get(dataset);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached;
  }

  // Close a stale fd from a previous (now outdated) load before opening a new one.
  if (cached && typeof cached.fd === 'number') {
    try { fs.closeSync(cached.fd); } catch { /* already closed / never opened — fine */ }
  }

  const ids = [];
  const offsets = [];
  const lengths = [];
  const raw = fs.readFileSync(indexPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, off, len] = trimmed.split('\t');
    if (id === undefined || off === undefined || len === undefined) continue;
    ids.push(id);
    offsets.push(parseInt(off, 10));
    lengths.push(parseInt(len, 10));
  }

  let fd;
  try {
    fd = fs.openSync(tokensPath, 'r');
  } catch {
    return null; // index exists but the token data file doesn't/can't be opened — treat as unavailable
  }

  const entry = { mtimeMs: stat.mtimeMs, ids, offsets, lengths, fd };
  _aboutnessIndexCache.set(dataset, entry);
  return entry;
}

/**
 * Binary-search `ids` (sorted, LC_ALL=C / plain-string order — matches
 * build_aboutness_index.py's sort) for an exact match. Returns the index
 * into the parallel offsets/lengths arrays, or -1 if not found.
 * @param {string[]} ids
 * @param {string} target
 * @returns {number}
 */
function bisectExact(ids, target) {
  let lo = 0, hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid] === target) return mid;
    if (ids[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Fetches one paper's preamble token set by source_id, seeking directly
 * to its byte range in the aboutness_<dataset>.jsonl file rather than
 * scanning — same O(log n) lookup + O(1) seek pattern as chunk-index.js.
 * Tokens are returned lowercased (aboutness is a soft topical signal, not
 * exact PQR-hash matching, so a case-insensitive comparison here is
 * intentional and does not need the case_insensitive merge machinery
 * similaritySearch() uses for real token search).
 *
 * Deliberately NOT cached across calls beyond the single fs.readSync —
 * only the small byte-offset index is cached (see loadAboutnessIndex);
 * re-reading one JSONL line per lookup is cheap (OS page cache absorbs
 * repeat reads within a session) and avoids an unbounded per-paper token
 * cache growing indefinitely on a long-running MCP server process.
 * @param {string} dataset
 * @param {string} sourceId
 * @returns {Set<string> | null}
 */
function getPaperAboutnessTokens(dataset, sourceId) {
  const index = loadAboutnessIndex(dataset);
  if (!index || !sourceId) return null;

  const i = bisectExact(index.ids, sourceId);
  if (i === -1) return null;

  const buf = Buffer.alloc(index.lengths[i]);
  try {
    fs.readSync(index.fd, buf, 0, index.lengths[i], index.offsets[i]);
  } catch {
    return null;
  }

  try {
    const record = JSON.parse(buf.toString('utf8'));
    return new Set((record.tokens || []).map(t => t.toLowerCase()));
  } catch {
    return null;
  }
}

/**
 * Re-orders a tqnn_similarity result set using paper-level aboutness —
 * WITHOUT changing which documents are included (threshold membership
 * was already decided in similaritySearch()) and WITHOUT modifying each
 * result's own weighted_score (left exactly as computed, so it remains a
 * pure, auditable reflection of raw token overlap — a separate
 * aboutness_factor/aboutness_matched_weight is attached instead, and only
 * an internal adjusted score derived from the two is used for sorting).
 *
 * @param {object[]} results - similaritySearch()'s raw `results` array
 *   (call this BEFORE applyCitationShapeRanking — see module header)
 * @param {string} dataset
 * @param {Array<{token:string, docCount:number, weight:number}>} tokenWeights
 *   - similaritySearch()'s own token_weights output. A merged
 *   case-insensitive group's `token` field (e.g. "imaging/Imaging") is
 *   split on '/' and only the first form's lowercase is used as the
 *   concept key — the weight already reflects the merged docCount, so no
 *   double-counting.
 * @param {number} [floor=0.5] - Minimum demotion factor (0-1). A paper
 *   with ZERO query-token overlap in its preamble is scaled to exactly
 *   this fraction of its original weighted_score, never lower, never
 *   excluded. 1.0 would make this a no-op; 0 would allow a full
 *   hard-exclude-equivalent demotion, deliberately not the default given
 *   the explicit soft-demote design decision (see build_aboutness_index.py
 *   header and the guideline_10 raw-candidate check that motivated it).
 * @returns {{ results: object[], aboutness_available: boolean }}
 */
function applyAboutnessReorder(results, dataset, tokenWeights, floor = 0.5) {
  const aboutnessIndex = loadAboutnessIndex(dataset);
  if (!aboutnessIndex) {
    return {
      results: results.map(r => ({ ...r, aboutness_factor: null, aboutness_matched_weight: null })),
      aboutness_available: false
    };
  }

  const rankTable = loadRankingTable(dataset); // for source_id lookup only — same cached table citation-shape uses

  const conceptWeights = new Map(); // lowercase concept -> weight
  let totalConceptWeight = 0;
  for (const tw of tokenWeights || []) {
    const key = tw.token.split('/')[0].toLowerCase();
    if (!conceptWeights.has(key)) {
      conceptWeights.set(key, tw.weight);
      totalConceptWeight += tw.weight;
    }
  }

  const augmented = results.map(r => {
    const chunkId = filereferenceToChunkId(r.filereference);
    const rankEntry = rankTable ? rankTable.get(chunkId) : undefined;
    const sourceId = rankEntry && rankEntry.source_id;
    if (!sourceId) {
      return { ...r, aboutness_factor: null, aboutness_matched_weight: null, _adjusted_score: r.weighted_score };
    }

    const paperTokens = getPaperAboutnessTokens(dataset, sourceId);
    if (!paperTokens) {
      return { ...r, aboutness_factor: null, aboutness_matched_weight: null, _adjusted_score: r.weighted_score };
    }

    let matchedWeight = 0;
    for (const [concept, weight] of conceptWeights) {
      if (paperTokens.has(concept)) matchedWeight += weight;
    }
    const ratio = totalConceptWeight > 0 ? matchedWeight / totalConceptWeight : 0;
    const factor = floor + (1 - floor) * ratio;

    return {
      ...r,
      aboutness_factor: Math.round(factor * 1000) / 1000,
      aboutness_matched_weight: Math.round(matchedWeight * 1000) / 1000,
      _adjusted_score: r.weighted_score * factor
    };
  });

  // Stable sort by adjusted score descending. weighted_score itself is
  // untouched on every result — applyCitationShapeRanking's tie-detection
  // (which groups by exact weighted_score equality) still works correctly
  // on whatever order it receives next.
  augmented.sort((a, b) => b._adjusted_score - a._adjusted_score);

  const cleaned = augmented.map(r => {
    const { _adjusted_score, ...rest } = r;
    return rest;
  });

  return { results: cleaned, aboutness_available: true };
}

module.exports = {
  loadRankingTable,
  filereferenceToChunkId,
  citationShapeScore,
  exactDuplicateKey,
  applyCitationShapeRanking,
  applySourceCap,
  applyFigureDemotion,
  applyAboutnessReorder,
  loadAboutnessIndex,
  getPaperAboutnessTokens,
  isSafeDatasetName,
  RANKING_DIR,
  ABOUTNESS_DIR
};
