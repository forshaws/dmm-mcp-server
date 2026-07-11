// resolver.js — tqnn_get resolver module for TQNN DMM MCP Server.
// TQNN MCP Server v1.4.0
//
// Loads tqnn_resolvers.json and dispatches tqnn_get operations to the
// appropriate handler based on filereference URI scheme prefix.
//
// Three operations:
//   ping  — is the resource reachable? returns status only
//   info  — metadata: size, date, content type (no content body)
//   fetch — full content retrieval (inline text or base64 binary, optional zip)
//
// Handlers:
//   memory      — in-memory namespace (filereferences stored via tqnn_store)
//   local_jsonl — local JSONL data files (e.g. Lindisfarne M1)
//   local_blob  — byte-offset fetch against a blob file via a storage_target
//                 fetch service (demo: deterministic physical-address retrieval)
//   local_lba   — raw 4KiB-sector/LBA fetch against a loop-device-backed
//                 drive via storage_target.py (SN655 Level 2 raw block demo)
//   url         — HTTP/S hosted resources
//   webhook     — developer-defined endpoint (glacier, S3, SharePoint, generic)

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const zlib    = require('zlib');

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

let _config = null;

/**
 * Load and cache tqnn_resolvers.json.
 * Searches: same dir as this file, then CWD.
 * @returns {object} Parsed resolver config
 */
function loadConfig() {
  if (_config) return _config;
  const candidates = [
    path.join(__dirname, 'tqnn_resolvers.json'),
    path.join(process.cwd(), 'tqnn_resolvers.json')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        _config = JSON.parse(fs.readFileSync(p, 'utf8'));
        process.stderr.write(`[tqnn-resolver] Loaded config: ${p}\n`);
        return _config;
      } catch (e) {
        throw new Error(`tqnn_resolvers.json parse error at ${p}: ${e.message}`);
      }
    }
  }
  // No config found — return a minimal default (memory handler only)
  process.stderr.write('[tqnn-resolver] WARNING: tqnn_resolvers.json not found — using built-in defaults (memory handler only)\n');
  _config = {
    resolvers: [{ scheme: 'memory://', type: 'memory', handler: 'memory', description: 'In-memory namespace' }],
    default_on_no_match: 'reject',
    fetch_options: { allow_zip: true, zip_threshold_bytes: 102400, max_inline_bytes: 1048576 }
  };
  return _config;
}

// ---------------------------------------------------------------------------
// ENV substitution
// ---------------------------------------------------------------------------

/**
 * Resolve "ENV:VAR_NAME" config values from environment.
 * Returns null if the env var is not set.
 * @param {string} value
 * @returns {string|null}
 */
function resolveEnv(value) {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('ENV:')) return value;
  const varName = value.slice(4);
  return process.env[varName] || null;
}

// ---------------------------------------------------------------------------
// Filereference parsing
// ---------------------------------------------------------------------------

/**
 * Strip DMM-appended ::timestamp suffix from filereference.
 * "memory://claude/test/brahma-2026-06-24::1782281928" → "memory://claude/test/brahma-2026-06-24::"
 * @param {string} ref
 * @returns {string}
 */
function normaliseRef(ref) {
  const m = ref.match(/^(.*?)::\d+$/);
  return m ? m[1] + '::' : ref;
}

/**
 * Detect whether a filereference uses a logical namespace prefix.
 * Logical prefixes follow [a-zA-Z0-9]+_ e.g. records_, invoices_, contracts_
 * Anything else (https://, C:\, \\server\, /mnt/) is non-logical.
 * @param {string} ref
 * @returns {boolean}
 */
function isLogicalPrefix(ref) {
  return /^[a-zA-Z0-9]+_/.test(ref);
}

/**
 * Find the resolver config entry for a given filereference.
 *
 * Resolution order:
 *   1. Logical prefix ([a-zA-Z0-9]+_): match against resolver schemes, longest first.
 *   2. Non-logical (URL, drive letter, UNC, mount point): use wildcard catch-all.
 *   3. No match and no catch-all: return null.
 *
 * @param {string} ref - Normalised filereference
 * @param {object[]} resolvers
 * @returns {object|null}
 */
function matchResolver(ref, resolvers) {
  // Always check explicit named schemes first (longest match), regardless of logical/non-logical.
  // This allows memory://, glacier://, or any developer-defined non-logical scheme
  // to be explicitly handled without falling through to the * catch-all.
  const named = [...resolvers]
    .filter(r => r.scheme !== '*')
    .sort((a, b) => b.scheme.length - a.scheme.length);
  const explicit = named.find(r => ref.startsWith(r.scheme));
  if (explicit) return explicit;

  if (isLogicalPrefix(ref)) {
    // Logical prefix with no explicit resolver — no match
    return null;
  } else {
    // Non-logical reference — route to * catch-all if configured
    return resolvers.find(r => r.scheme === '*') || null;
  }
}

// ---------------------------------------------------------------------------
// In-memory store (populated by tqnn_store calls during session)
// ---------------------------------------------------------------------------

// Map: normalised filereference → { stored_at, pattern, size_bytes }
const memoryStore = new Map();

/**
 * Called by tqnn_store handler to register an in-memory record.
 * @param {string} ref - Filereference (will be normalised)
 * @param {string} pattern - Stored pattern JSON string
 */
function registerMemory(ref, pattern) {
  const key = normaliseRef(ref);
  memoryStore.set(key, {
    stored_at: new Date().toISOString(),
    pattern,
    size_bytes: Buffer.byteLength(pattern, 'utf8')
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// ── memory handler ──────────────────────────────────────────────────────────

async function handleMemory(ref, operation) {
  const key = normaliseRef(ref);
  const record = memoryStore.get(key);

  if (operation === 'ping') {
    return {
      status: record ? 'AVAILABLE' : 'NOT_FOUND',
      resolver: 'memory',
      filereference: ref
    };
  }

  if (operation === 'info') {
    if (!record) return notFound(ref, 'memory');
    return {
      status: 'AVAILABLE',
      resolver: 'memory',
      filereference: ref,
      size_bytes: record.size_bytes,
      stored_at: record.stored_at,
      content_type: 'application/json',
      note: 'In-memory namespace — content is the metadata pattern stored at write time. Cleared on server restart.'
    };
  }

  if (operation === 'fetch') {
    if (!record) return notFound(ref, 'memory');
    return {
      status: 'OK',
      resolver: 'memory',
      filereference: ref,
      content_type: 'application/json',
      size_bytes: record.size_bytes,
      encoding: 'utf8',
      content: record.pattern,
      compressed: false,
      stored_at: record.stored_at
    };
  }

  return unknownOperation(operation);
}

// ── local_jsonl handler ─────────────────────────────────────────────────────

async function handleLocalJsonl(ref, operation, resolverConfig) {
  const cfg = resolverConfig.config || {};
  const basePath = cfg.base_path || '/data/';
  const maxBytes = cfg.max_fetch_bytes || 5242880;
  const encoding = cfg.encoding || 'utf8';

  // Parse filereference: records_0001.jsonl::line28::REC-00010028::
  // Strip trailing :: and split on remaining ::
  const clean = normaliseRef(ref).replace(/::$/, '');
  const parts = clean.split('::');
  const filename = parts[0];  // e.g. records_0001.jsonl
  const lineHint = parts[1];  // e.g. line28 or REC-00010028 (optional)

  const filepath = path.join(basePath, filename);

  if (operation === 'ping') {
    try {
      await fs.promises.access(filepath, fs.constants.R_OK);
      return { status: 'AVAILABLE', resolver: 'local_jsonl', filereference: ref, path: filepath };
    } catch {
      return { status: 'NOT_FOUND', resolver: 'local_jsonl', filereference: ref, path: filepath };
    }
  }

  let stat;
  try {
    stat = await fs.promises.stat(filepath);
  } catch {
    return notFound(ref, 'local_jsonl');
  }

  if (operation === 'info') {
    return {
      status: 'AVAILABLE',
      resolver: 'local_jsonl',
      filereference: ref,
      path: filepath,
      size_bytes: stat.size,
      modified: stat.mtime.toISOString(),
      content_type: 'application/jsonl',
      line_hint: lineHint || null
    };
  }

  if (operation === 'fetch') {
    if (stat.size > maxBytes) {
      return {
        status: 'TOO_LARGE',
        resolver: 'local_jsonl',
        filereference: ref,
        size_bytes: stat.size,
        max_bytes: maxBytes,
        message: `File exceeds max_fetch_bytes (${maxBytes}). Use info to inspect, or request a zip.`
      };
    }

    // If lineHint looks like "lineN", extract that line
    const lineMatch = lineHint && lineHint.match(/^line(\d+)$/i);
    let content;

    if (lineMatch) {
      const lineNum = parseInt(lineMatch[1], 10);
      const raw = await fs.promises.readFile(filepath, encoding);
      const lines = raw.split('\n').filter(Boolean);
      const line = lines[lineNum - 1];
      if (!line) {
        return { status: 'NOT_FOUND', resolver: 'local_jsonl', filereference: ref, message: `Line ${lineNum} not found in ${filename}` };
      }
      content = line;
    } else {
      content = await fs.promises.readFile(filepath, encoding);
    }

    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const { allow_zip, zip_threshold_bytes } = getGlobalFetchOptions();

    if (allow_zip && sizeBytes > zip_threshold_bytes) {
      const compressed = zlib.gzipSync(Buffer.from(content, 'utf8'));
      return {
        status: 'OK',
        resolver: 'local_jsonl',
        filereference: ref,
        content_type: 'application/jsonl',
        size_bytes: sizeBytes,
        compressed: true,
        compression: 'gzip',
        content_base64: compressed.toString('base64'),
        line_hint: lineHint || null
      };
    }

    return {
      status: 'OK',
      resolver: 'local_jsonl',
      filereference: ref,
      content_type: 'application/jsonl',
      size_bytes: sizeBytes,
      encoding,
      content,
      compressed: false,
      line_hint: lineHint || null
    };
  }

  return unknownOperation(operation);
}

// ── local_blob handler ──────────────────────────────────────────────────────
//
// Byte-offset fetch against a blob file, via a standalone storage_target
// fetch service reached over TCP. Deliberately kept separate from
// local_jsonl (which reads a whole file / line locally in-process): the
// point of this handler is to time resolution and physical fetch as two
// distinct hops, matching the "resolve to a coordinate, then fetch from
// physical media" story rather than an in-process file read.
//
// Filereference format: <blobfile>::off<N>::len<N>::
//   e.g. lindisfarne_blob_001.bin::off18446744::len2048::

const net = require('net');

async function fetchFromStorageTarget(host, portNum, filename, offset, length) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: portNum }, () => {
      socket.write(JSON.stringify({ filename, offset, length }) + '\n');
    });
    let chunks = [];
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body);
      } catch (e) {
        reject(new Error(`storage_target response parse error: ${e.message}`));
      }
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('storage_target connection timed out'));
    });
  });
}

async function handleLocalBlob(ref, operation, resolverConfig) {
  const cfg = resolverConfig.config || {};
  const targetHost = cfg.target_host || '127.0.0.1';
  const targetPort = cfg.target_port || 9600;

  const clean = normaliseRef(ref).replace(/::$/, '');
  const parts = clean.split('::');
  const filename = parts[0];
  const offMatch = (parts[1] || '').match(/^off(\d+)$/);
  const lenMatch = (parts[2] || '').match(/^len(\d+)$/);

  if (!offMatch || !lenMatch) {
    return {
      status: 'ERROR',
      resolver: 'local_blob',
      filereference: ref,
      message: 'Expected filereference format <file>::offN::lenN::'
    };
  }
  const offset = parseInt(offMatch[1], 10);
  const length = parseInt(lenMatch[1], 10);

  if (operation === 'ping') {
    try {
      const result = await fetchFromStorageTarget(targetHost, targetPort, filename, 0, 0);
      return { status: result.status === 'ERROR' ? 'NOT_FOUND' : 'AVAILABLE', resolver: 'local_blob', filereference: ref };
    } catch (e) {
      return { status: 'UNREACHABLE', resolver: 'local_blob', filereference: ref, error: e.message };
    }
  }

  if (operation === 'info') {
    return { status: 'AVAILABLE', resolver: 'local_blob', filereference: ref, filename, offset, length };
  }

  if (operation === 'fetch') {
    const resolveEnd = process.hrtime.bigint();
    try {
      const result = await fetchFromStorageTarget(targetHost, targetPort, filename, offset, length);
      const fetchEnd = process.hrtime.bigint();
      if (result.status !== 'OK') {
        return { status: result.status || 'ERROR', resolver: 'local_blob', filereference: ref, message: result.message || 'storage_target returned an error' };
      }
      return {
        status: 'OK',
        resolver: 'local_blob',
        filereference: ref,
        filename,
        offset,
        length,
        fetch_ms: Number(fetchEnd - resolveEnd) / 1e6,
        encoding: 'base64',
        content_base64: result.content_base64
      };
    } catch (e) {
      return { status: 'UNREACHABLE', resolver: 'local_blob', filereference: ref, error: e.message };
    }
  }

  return unknownOperation(operation);
}

// ── local_lba handler ───────────────────────────────────────────────────────
//
// Raw 4KiB-sector fetch against a loop-device-backed drive, via the same
// standalone storage_target TCP service pattern as local_blob — but no
// filename, no VFS, no byte offsets. The coordinate is a hardware LBA and
// a sector count, matching how the appliance's storage_target.py actually
// seeks against /dev/loop0 (SN655 Level 2 raw block storage demo).
//
// Filereference format: <pool_name>::lba<N>::sectors<N>::
//   e.g. sn655_pool_001::lba1380::sectors1::
//
// Parsed the same way as local_blob: split on '::' and match each token
// fully anchored by position. This is deliberately NOT a whole-string
// regex against a trailing "::" — TQNN's timestamp round-trip does not
// reliably leave one on the end (see normaliseRef), so anchoring parsing
// to string-end would silently fail on non-fpd records. Position-based
// split matching is immune to that regardless of what survives at the end.

async function fetchFromStorageTargetLba(host, portNum, lba, sectors) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: portNum }, () => {
      socket.write(JSON.stringify({ lba, sectors }) + '\n');
    });
    let chunks = [];
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body);
      } catch (e) {
        reject(new Error(`storage_target response parse error: ${e.message}`));
      }
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('storage_target connection timed out'));
    });
  });
}

async function handleLocalLba(ref, operation, resolverConfig) {
  const cfg = resolverConfig.config || {};
  const targetHost = cfg.target_host || '127.0.0.1';
  const targetPort = cfg.target_port || 9600;
  const sectorSize = cfg.sector_size || 4096;

  const clean = normaliseRef(ref).replace(/::$/, '');
  const parts = clean.split('::');
  const poolName = parts[0];
  const lbaMatch     = (parts[1] || '').match(/^lba(\d+)$/);
  const sectorsMatch = (parts[2] || '').match(/^sectors(\d+)$/);

  if (!lbaMatch || !sectorsMatch) {
    return {
      status: 'ERROR',
      resolver: 'local_lba',
      filereference: ref,
      message: 'Expected filereference format <pool>::lbaN::sectorsN::'
    };
  }
  const lba = parseInt(lbaMatch[1], 10);
  const sectors = parseInt(sectorsMatch[1], 10);

  if (operation === 'ping') {
    try {
      // Probe sector 0 — checks storage_target reachability, not this
      // specific record (sector 0 is guaranteed to exist on any populated pool).
      const result = await fetchFromStorageTargetLba(targetHost, targetPort, 0, 1);
      return { status: result.status === 'OK' ? 'AVAILABLE' : 'UNREACHABLE', resolver: 'local_lba', filereference: ref };
    } catch (e) {
      return { status: 'UNREACHABLE', resolver: 'local_lba', filereference: ref, error: e.message };
    }
  }

  if (operation === 'info') {
    return {
      status: 'AVAILABLE',
      resolver: 'local_lba',
      filereference: ref,
      pool: poolName,
      lba,
      sectors,
      sector_size: sectorSize,
      byte_length: sectors * sectorSize
    };
  }

  if (operation === 'fetch') {
    const resolveEnd = process.hrtime.bigint();
    try {
      const result = await fetchFromStorageTargetLba(targetHost, targetPort, lba, sectors);
      const fetchEnd = process.hrtime.bigint();
      if (result.status !== 'OK') {
        return { status: result.status || 'ERROR', resolver: 'local_lba', filereference: ref, message: result.message || 'storage_target returned an error' };
      }
      return {
        status: 'OK',
        resolver: 'local_lba',
        filereference: ref,
        pool: poolName,
        lba,
        sectors,
        fetch_ms: Number(fetchEnd - resolveEnd) / 1e6,
        encoding: 'base64',
        content_base64: result.content_base64
      };
    } catch (e) {
      return { status: 'UNREACHABLE', resolver: 'local_lba', filereference: ref, error: e.message };
    }
  }

  return unknownOperation(operation);
}

// ── url handler ─────────────────────────────────────────────────────────────

async function handleUrl(ref, operation, resolverConfig) {
  const cfg = resolverConfig.config || {};
  const timeoutMs = cfg.timeout_ms || 8000;
  const maxBytes  = cfg.max_fetch_bytes || 10485760;

  // Extract URL from filereference: https://example.com/doc.pdf::
  const url = normaliseRef(ref).replace(/::$/, '');

  if (operation === 'ping') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      return {
        status: resp.ok ? 'AVAILABLE' : 'HTTP_ERROR',
        resolver: 'url',
        filereference: ref,
        http_status: resp.status,
        url
      };
    } catch (e) {
      return { status: 'UNREACHABLE', resolver: 'url', filereference: ref, url, error: e.message };
    }
  }

  if (operation === 'info') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) return { status: 'HTTP_ERROR', resolver: 'url', filereference: ref, http_status: resp.status };
      return {
        status: 'AVAILABLE',
        resolver: 'url',
        filereference: ref,
        url,
        http_status: resp.status,
        content_type: resp.headers.get('content-type') || 'unknown',
        size_bytes: resp.headers.get('content-length') ? parseInt(resp.headers.get('content-length'), 10) : null,
        last_modified: resp.headers.get('last-modified') || null,
        etag: resp.headers.get('etag') || null
      };
    } catch (e) {
      return { status: 'UNREACHABLE', resolver: 'url', filereference: ref, url, error: e.message };
    }
  }

  if (operation === 'fetch') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) return { status: 'HTTP_ERROR', resolver: 'url', filereference: ref, http_status: resp.status };

      const contentType = resp.headers.get('content-type') || 'application/octet-stream';
      const buf = Buffer.from(await resp.arrayBuffer());

      if (buf.length > maxBytes) {
        return {
          status: 'TOO_LARGE',
          resolver: 'url',
          filereference: ref,
          size_bytes: buf.length,
          max_bytes: maxBytes,
          content_type: contentType
        };
      }

      const isText = contentType.includes('text') || contentType.includes('json') || contentType.includes('xml');
      const { allow_zip, zip_threshold_bytes } = getGlobalFetchOptions();

      if (allow_zip && buf.length > zip_threshold_bytes) {
        const compressed = zlib.gzipSync(buf);
        return {
          status: 'OK',
          resolver: 'url',
          filereference: ref,
          url,
          content_type: contentType,
          size_bytes: buf.length,
          compressed: true,
          compression: 'gzip',
          content_base64: compressed.toString('base64')
        };
      }

      return {
        status: 'OK',
        resolver: 'url',
        filereference: ref,
        url,
        content_type: contentType,
        size_bytes: buf.length,
        compressed: false,
        ...(isText
          ? { encoding: 'utf8', content: buf.toString('utf8') }
          : { encoding: 'base64', content_base64: buf.toString('base64') })
      };
    } catch (e) {
      return { status: 'UNREACHABLE', resolver: 'url', filereference: ref, url, error: e.message };
    }
  }

  return unknownOperation(operation);
}

// ── webhook handler (glacier, S3, SharePoint, generic) ──────────────────────

async function handleWebhook(ref, operation, resolverConfig) {
  const cfg = resolverConfig.config || {};
  const webhookUrl  = resolveEnv(cfg.webhook_url);
  const authHeader  = cfg.auth_header || 'X-TQNN-Secret';
  const authValue   = resolveEnv(cfg.auth_value);
  const estHours    = cfg.estimated_hours;

  // For cold storage ping/info — don't call webhook, return status directly
  // (cold storage retrieval is async; no URL needed for status responses)
  if (resolverConfig.type === 'cold_storage' && operation !== 'fetch') {
    return {
      status: operation === 'ping' ? 'COLD_STORAGE' : 'RETRIEVAL_PENDING',
      resolver: 'webhook',
      filereference: ref,
      estimated_hours: estHours,
      message: `Resource is in cold storage. Submit a fetch request to initiate retrieval.`
    };
  }

  // For non-cold-storage webhooks, URL is required
  if (!webhookUrl) {
    return {
      status: 'RESOLVER_NOT_CONFIGURED',
      resolver: 'webhook',
      filereference: ref,
      message: `Webhook URL not configured for scheme "${resolverConfig.scheme}". Set the required ENV var in .env.`
    };
  }

  // Build webhook request payload
  const payload = {
    operation,
    filereference: ref,
    resolver_type: resolverConfig.type,
    timestamp: new Date().toISOString(),
    request_id: crypto.randomBytes(8).toString('hex')
  };

  const headers = { 'Content-Type': 'application/json' };
  if (authValue) headers[authHeader] = authValue;

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });

    const body = await resp.json().catch(() => ({}));

    if (resolverConfig.type === 'cold_storage' && resp.ok) {
      // Cold storage fetch: initiate retrieval, return ticket
      return {
        status: 'RETRIEVAL_PENDING',
        resolver: 'webhook',
        filereference: ref,
        ticket_id: body.ticket_id || payload.request_id,
        estimated_hours: body.estimated_hours || estHours,
        message: body.message || 'Retrieval initiated. Poll with operation:ping and the ticket_id.'
      };
    }

    return {
      status: resp.ok ? 'OK' : 'WEBHOOK_ERROR',
      resolver: 'webhook',
      filereference: ref,
      http_status: resp.status,
      ...body
    };
  } catch (e) {
    return { status: 'WEBHOOK_UNREACHABLE', resolver: 'webhook', filereference: ref, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFound(ref, resolver) {
  return { status: 'NOT_FOUND', resolver, filereference: ref };
}

function unknownOperation(op) {
  return { status: 'ERROR', message: `Unknown operation: "${op}". Valid: ping, info, fetch` };
}

function getGlobalFetchOptions() {
  const cfg = loadConfig();
  return cfg.fetch_options || { allow_zip: true, zip_threshold_bytes: 102400, max_inline_bytes: 1048576 };
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a tqnn_get operation to the appropriate resolver.
 *
 * @param {string} filereference - The filereference to resolve
 * @param {'ping'|'info'|'fetch'} operation - What to do
 * @returns {Promise<object>} Result object (always resolves, never throws)
 */
async function resolverDispatch(filereference, operation) {
  const cfg = loadConfig();
  const ref = filereference.trim();
  const resolver = matchResolver(ref, cfg.resolvers);

  if (!resolver) {
    const logical = isLogicalPrefix(ref);
    const ns = ref.split('_')[0] + '_';
    return {
      status: 'NO_RESOLVER',
      filereference: ref,
      is_logical_prefix: logical,
      message: logical
        ? `No resolver configured for logical namespace "${ns}". Add a matching scheme entry to tqnn_resolvers.json.`
        : `Non-logical filereference (URL, drive letter, UNC, mount point) with no catch-all webhook configured. Set RESOLVER_DEFAULT_WEBHOOK_URL in .env and add a "*" scheme entry to tqnn_resolvers.json.`,
      hint: logical
        ? `Add { "scheme": "${ns}", "handler": "local_jsonl" or "webhook", "config": {...} } to tqnn_resolvers.json.`
        : 'Add a "*" catch-all entry to tqnn_resolvers.json with handler: "webhook" and set RESOLVER_DEFAULT_WEBHOOK_URL in .env.'
    };
  }

  process.stderr.write(`[tqnn-resolver] ${operation.toUpperCase()} "${ref}" → handler: ${resolver.handler} (${resolver.type})\n`);

  try {
    switch (resolver.handler) {
      case 'memory':      return await handleMemory(ref, operation);
      case 'local_jsonl': return await handleLocalJsonl(ref, operation, resolver);
      case 'local_blob':  return await handleLocalBlob(ref, operation, resolver);
      case 'local_lba':   return await handleLocalLba(ref, operation, resolver);
      case 'url':         return await handleUrl(ref, operation, resolver);
      case 'webhook':     return await handleWebhook(ref, operation, resolver);
      default:
        return { status: 'ERROR', filereference: ref, message: `Unknown handler type: "${resolver.handler}"` };
    }
  } catch (err) {
    process.stderr.write(`[tqnn-resolver] Unhandled error for "${ref}": ${err.message}\n`);
    return { status: 'ERROR', filereference: ref, message: err.message };
  }
}

module.exports = { resolverDispatch, registerMemory, loadConfig, normaliseRef };
