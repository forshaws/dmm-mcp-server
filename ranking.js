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
// Ranking data is precomputed OFFLINE per dataset by
// build_shard_ranking_metadata.py, run once against a dataset's corpus
// shards. Output is a flat, pipe-delimited file:
//     chunk_id|dd|cwr|pd|ent
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
 * Parse one line of a .rank file into a metadata object.
 * @param {string} line - "chunk_id|dd|cwr|pd|ent"
 * @returns {{chunk_id: string, dd: number, cwr: number, pd: number, ent: number} | null}
 */
function parseRankLine(line) {
  const parts = line.split('|');
  if (parts.length !== 5) return null;
  const [chunk_id, dd, cwr, pd, ent] = parts;
  return {
    chunk_id,
    dd: parseFloat(dd),
    cwr: parseFloat(cwr),
    pd: parseFloat(pd),
    ent: parseFloat(ent)
  };
}

/**
 * Load (and cache) the ranking table for a dataset. Returns null — never
 * throws — if no ranking file exists for this dataset, so callers can
 * treat "no ranking data" as a normal, expected case rather than an error.
 * Cache is invalidated on file mtime change, matching the pattern already
 * used for tqnn_mcp_credentials.json in index.js.
 * @param {string} dataset
 * @returns {Map<string, {dd:number,cwr:number,pd:number,ent:number}> | null}
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
      return { ...r, citation_shape: null };
    }
    return {
      ...r,
      citation_shape: {
        dd: entry.dd,
        cwr: entry.cwr,
        pd: entry.pd,
        ent: entry.ent,
        score: Math.round(citationShapeScore(entry) * 1000) / 1000
      }
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

      reranked.push(...distinct, ...duplicates, ...withoutScore);
    } else {
      reranked.push({ ...tieGroup[0], duplicate_of: null });
    }
    i = j;
  }

  return { results: reranked, ranking_available: true };
}

module.exports = {
  loadRankingTable,
  filereferenceToChunkId,
  citationShapeScore,
  exactDuplicateKey,
  applyCitationShapeRanking,
  isSafeDatasetName,
  RANKING_DIR
};
