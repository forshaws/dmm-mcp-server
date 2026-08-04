// chunk-index.js — In-memory chunk_id -> (byte_offset, byte_length) index
// TQNN MCP Server — companion to resolver.js's chunk_index handler
//
// Problem: TOR's token-link lookups (getTokenLinks / add_cache_entry_with_links)
// return bare chunk_id strings with no logical namespace prefix, so they can't
// be routed to a file/line the way records_.../bamburgh_... refs are (see
// local_jsonl in resolver.js). The corpus they point into is a single 4GB+
// JSONL file (corpus_full.jsonl, ~1.66M lines) — reading or scanning the
// whole thing per lookup is not viable.
//
// This module loads a prebuilt, sorted index (chunk_id<TAB>offset<TAB>length
// per line, built offline by build_chunk_index.py) into three parallel
// arrays and binary-searches the sorted chunk_id array. At ~1.66M entries
// this is a few hundred MB resident — loaded once, cached, refreshed only
// if the index file's mtime changes (same cache pattern as ranking.js).
//
// IMPORTANT — sort order must match exactly between build time and lookup
// time. build_chunk_index.py sorts with `LC_ALL=C sort -k1,1` (plain byte
// order); binary search here uses plain JS string comparison (<, >, ===),
// which is also code-unit/byte order for the ASCII chunk_id values in this
// corpus (digits 0-9, hex a-f/A-F, hyphens). If a chunk_id character set
// ever changes, re-verify these two orderings still agree — a mismatch
// here silently returns wrong results without erroring, exactly the class
// of bug already found and fixed once in getTokenLinks.php's PHP
// implementation of the same numeric-vs-string comparison hazard.

const fs = require('fs');

// indexPath -> { mtimeMs, ids: string[], offsets: Float64Array, lengths: Uint32Array }
const _indexCache = new Map();

/**
 * Load (and cache) a chunk index file. Returns null — never throws for a
 * missing file — so callers can treat "index not built yet" as an expected
 * state. Throws only if the file exists but is internally inconsistent
 * (not sorted), since silently binary-searching an unsorted file returns
 * wrong answers rather than an error.
 * @param {string} indexPath
 * @returns {{mtimeMs:number, ids:string[], offsets:Float64Array, lengths:Uint32Array} | null}
 */
function loadChunkIndex(indexPath) {
  if (!indexPath) return null;

  let stat;
  try {
    stat = fs.statSync(indexPath);
  } catch {
    return null; // index not built yet — expected until build_chunk_index.py has run
  }

  const cached = _indexCache.get(indexPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached;
  }

  const ids = [];
  const offsetsArr = [];
  const lengthsArr = [];

  const raw = fs.readFileSync(indexPath, 'utf8');
  let lastId = null;
  let lineNo = 0;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    lineNo++;
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab1 === -1 || tab2 === -1) {
      throw new Error(`chunk_index malformed at line ${lineNo}: expected "chunk_id\\toffset\\tlength"`);
    }
    const id = line.slice(0, tab1);
    const offset = Number(line.slice(tab1 + 1, tab2));
    const length = Number(line.slice(tab2 + 1));

    if (lastId !== null && id < lastId) {
      throw new Error(
        `chunk_index.tsv is not sorted (line ${lineNo}: "${id}" sorts before "${lastId}"). ` +
        `Rebuild with: LC_ALL=C sort -t$'\\t' -k1,1 chunk_index.unsorted.tsv > chunk_index.tsv`
      );
    }
    lastId = id;

    ids.push(id);
    offsetsArr.push(offset);
    lengthsArr.push(length);
  }

  const entry = {
    mtimeMs: stat.mtimeMs,
    ids,
    offsets: Float64Array.from(offsetsArr),
    lengths: Uint32Array.from(lengthsArr)
  };
  _indexCache.set(indexPath, entry);
  process.stderr.write(`[chunk-index] Loaded ${ids.length} entries from ${indexPath}\n`);
  return entry;
}

/**
 * Binary search a sorted array of chunk_id strings for an exact match.
 * @param {string[]} ids - sorted ascending (plain string comparison)
 * @param {string} chunkId
 * @returns {number} index into ids, or -1 if not found
 */
function binarySearchChunkId(ids, chunkId) {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = ids[mid];
    if (v === chunkId) return mid;
    if (v < chunkId) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Look up a chunk_id's byte coordinate in the corpus file.
 * @param {string} indexPath
 * @param {string} chunkId
 * @returns {{offset:number, length:number} | null}
 */
function lookupChunk(indexPath, chunkId) {
  const idx = loadChunkIndex(indexPath);
  if (!idx) return null;
  const pos = binarySearchChunkId(idx.ids, chunkId);
  if (pos === -1) return null;
  return { offset: idx.offsets[pos], length: idx.lengths[pos] };
}

module.exports = { loadChunkIndex, binarySearchChunkId, lookupChunk };
