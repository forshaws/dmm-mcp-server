// index.js — TQNN DMM MCP Server
// TQNN MCP Server v1.9.0
//
// Exposes TQNN DMM associative memory as MCP tools for Claude and other
// MCP-compatible LLMs.
//
// Modes:
//   stdio — for Claude Code integration (default, no auth required)
//   SSE   — for claude.ai MCP connector (OAuth 2.1 required)
//
// Start:
//   MCP_MODE=stdio node index.js
//   MCP_MODE=sse   node index.js
//
// OAuth 2.1 endpoints (SSE mode only):
//   /.well-known/oauth-protected-resource  — RFC 9728
//   /.well-known/oauth-authorization-server — RFC 8414
//   POST /oauth/register                   — Dynamic Client Registration (RFC 7591)
//   GET  /oauth/authorize                  — Authorization endpoint
//   POST /oauth/authorize                  — Consent form submission
//   POST /oauth/token                      — Token endpoint (auth code + refresh)

// ── Load .env ────────────────────────────────────────────────────────────────
try {
  const fs = require('fs');
  const env = fs.readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    // Handle values that may contain = (e.g. base64 secrets)
    const eqIdx = line.search(/(?<![#\s])=/);
    if (eqIdx === -1) continue;
    const rawKey = line.slice(0, eqIdx);
    const rawVal = line.slice(eqIdx + 1);
    const m = rawKey.match(/^\s*([^#\s]+)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = rawVal.trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env optional */ }

// ── TLS (tqnn.local self-signed cert) ────────────────────────────────────────
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
}

// ── Dependencies ──────────────────────────────────────────────────────────────
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { TQNNClient } = require('./tqnn-client');
const { similaritySearch, pqrHash, pqrHashReversed, tokenise, stripTimestamp } = require('./similarity');
const { OAuthServer, readBody } = require('./oauth');
const { resolverDispatch, registerMemory } = require('./resolver');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:    process.env.TQNN_BASE_URL    || 'https://tqnn.local',
  apiKey:     process.env.TQNN_API_KEY     || '',
  apiSecret:  process.env.TQNN_API_SECRET  || '',
  dataset:    process.env.TQNN_DATASET     || '',
  mode:       (process.env.MCP_MODE        || 'stdio').toLowerCase(),
  port:       parseInt(process.env.MCP_PORT || '3100', 10),
  publicUrl:  process.env.TQNN_PUBLIC_URL  || '',   // e.g. https://sprint-umpire-wrongdoer.ngrok-free.dev
  mcpSecret:  process.env.TQNN_MCP_SECRET  || '',   // HMAC secret for OAuth bearer-token signing (NOT the PQR key — see TQNN_PQR_KEY below, a separate secret for a separate trust boundary)
  oauthUser:  process.env.TQNN_OAUTH_USER  || 'admin',
  oauthPass:  process.env.TQNN_OAUTH_PASS  || '',   // plaintext from .env, hashed immediately
  pqrKey:     process.env.TQNN_PQR_KEY     || '',   // HMAC key for PQR content tokenisation — see similarity.js's getPqrKey()
};

if (!CONFIG.apiKey || !CONFIG.apiSecret) {
  process.stderr.write('[tqnn-mcp] WARNING: TQNN_API_KEY or TQNN_API_SECRET not set\n');
}

// v1.9.0 — PQR is opt-in per call (pqr:true on tqnn_search/tqnn_similarity/
// tqnn_store), and now hmac:true is a further opt-in on TOP of pqr:true
// (default false — see similarity.js's V1.9.0 header). So this is an
// informational note, not a warning: a deployment that never passes
// hmac:true (including one still running entirely on data ingested before
// this version, e.g. an existing Lindisfarne corpus under pqr:true/
// hmac:false) has no reason to configure this yet, and nothing breaks by
// leaving it unset. Only a call that explicitly passes hmac:true without
// TQNN_PQR_KEY set will fail (similarity.js's getPqrKey() throws) — this
// note just makes the key's existence and purpose easy to find before
// that becomes a live question.
if (!CONFIG.pqrKey || CONFIG.pqrKey.length < 32) {
  process.stderr.write(
    '[tqnn-mcp] NOTE: TQNN_PQR_KEY not set (or under 32 chars). Not required unless a tool ' +
    'call explicitly passes hmac:true (tqnn_search, tqnn_similarity, tqnn_store) — pqr:true ' +
    'alone (the current default, and what any pre-existing corpus was ingested under) still ' +
    'works with no key, using the unkeyed self-salting scheme. hmac:true is the keyed, ' +
    'dictionary-attack-resistant option for NEW ingests going forward. Generate a key with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"\n' +
    '[tqnn-mcp]       Set TQNN_PQR_KEY=<value> in .env when ready to start using hmac:true.\n' +
    '[tqnn-mcp]       NOTE: hmac:true and hmac:false produce different tokens for identical ' +
    'input, by design — search and store must use the same hmac setting, and switching an ' +
    'existing corpus over means re-ingesting it under hmac:true.\n'
  );
}

// ── Per-employee DMM credential resolution ──────────────────────────────────────
// tqnn_mcp_credentials.json maps an authenticated employee (username, from
// oauth.js's validateToken) to their own DMM sub-credential pair — generated
// via the appliance's ACL console (tqnn_acl_manager.php), NOT invented here.
// Sending the right sub-credential means dataset whitelisting is enforced by
// esec.php's tqnn_acl_gate() at the appliance itself — this file never
// duplicates that logic, it just picks which credential pair to send.
//
// If the file is missing, or a given username has no specific entry, we fall
// back to CONFIG.apiKey/apiSecret (the static .env pair) — so stdio mode
// (Claude Code, no OAuth/no username) and any not-yet-migrated setup keep
// working exactly as before.
const CRED_FILE = path.join(__dirname, 'tqnn_mcp_credentials.json');
let _credCache = null;
let _credMtime = 0;

function loadCredentials() {
  try {
    const stat = fs.statSync(CRED_FILE);
    if (_credCache && stat.mtimeMs === _credMtime) return _credCache;
    const raw = fs.readFileSync(CRED_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _credCache = parsed && typeof parsed === 'object' ? parsed : null;
    _credMtime = stat.mtimeMs;
    return _credCache;
  } catch {
    return null; // file missing/unreadable/invalid — fall back to CONFIG default
  }
}

const _clientCache = new Map(); // "apikey:apisecret" → TQNNClient (reused across calls)

/**
 * Resolve the TQNNClient to use for a given caller.
 * @param {{ username?: string, client_id?: string }} [authResult] - from oauth.js validateToken(), absent in stdio mode
 * @returns {TQNNClient}
 */
function getClientFor(authResult) {
  const username = authResult && authResult.username;
  const creds    = loadCredentials();

  let pair = null;
  if (creds && username && creds.users && creds.users[username]) {
    pair = creds.users[username];
  } else if (creds && creds.default) {
    pair = creds.default;
  }

  const apiKey    = (pair && pair.sub_apikey)    || CONFIG.apiKey;
  const apiSecret = (pair && pair.sub_apisecret) || CONFIG.apiSecret;
  // Each credential entry can optionally declare its own default dataset —
  // used for ping() and any call that doesn't pass dataset explicitly.
  // Falls back to CONFIG.dataset (.env TQNN_DATASET) if not set. This
  // matters because a sub-credential's ACL whitelist may not include
  // CONFIG.dataset at all, in which case ping() would otherwise 403.
  const dataset   = (pair && pair.dataset) || CONFIG.dataset;

  const cacheKey = `${apiKey}:${apiSecret}:${dataset}`;
  if (!_clientCache.has(cacheKey)) {
    _clientCache.set(cacheKey, new TQNNClient({
      baseUrl:   CONFIG.baseUrl,
      apiKey,
      apiSecret,
      dataset
    }));
  }
  return _clientCache.get(cacheKey);
}

// ── MCP Server ─────────────────────────────────────────────────────────────────
// A fresh McpServer instance must be created per connection — the SDK forbids
// connecting one Server/Protocol instance to more than one transport at a time
// ("Already connected to a transport"). stdio mode only ever opens one
// connection, but SSE mode can see many (client reconnects, multiple clients,
// idle timeouts), so we wrap construction + tool registration in a factory.
function createMcpServer(authResult) {
  const server = new McpServer({
    name: 'tqnn-dmm',
    version: '1.9.0'
  });

  // Resolved once per connection (matches the per-connection McpServer factory
  // pattern already used here) — every tool call on this connection uses the
  // same employee-scoped DMM credential.
  const client = getClientFor(authResult);

  // ── Tool: tqnn_status ───────────────────────────────────────────────────────
  server.tool(
  'tqnn_status',
  'Check TQNN DMM connectivity and confirm the associative memory layer is reachable. Call this at session start to self-orient.',
  {},
  async () => {
    try {
      const result = await client.ping();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'ok',
            base_url: CONFIG.baseUrl,
            dataset: CONFIG.dataset || '(default)',
            dmm_response: result
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

// ── Tool: tqnn_discover_datasets ────────────────────────────────────────────
server.tool(
  'tqnn_discover_datasets',
  'Discover which datasets are visible to the caller\'s current DMM credential. ' +
  'For an employee mapped in tqnn_mcp_credentials.json, this reports THEIR sub-credential\'s ' +
  'ACL whitelist (scope: sub_credential) — the same dataset access enforced on every other ' +
  'tool call on this connection. For the .env fallback pair (stdio mode, or an unmapped ' +
  'employee), it reports the owner\'s full namespace (scope: owner). Call this to find out ' +
  'what a "dataset" argument can legally be set to before calling tqnn_search/tqnn_similarity ' +
  'with an unfamiliar one, or to self-orient at session start alongside tqnn_status.',
  {},
  async () => {
    try {
      const result = await client.discoverDatasets();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            scope: result.scope,
            label: result.label,
            permissions: result.permissions,
            datasets: result.datasets,
            dataset_count: result.dataset_count,
            default_dataset: result.default_dataset,
            // default_dataset from the ACL is only ever non-null for a single-dataset
            // credential. The MCP server's OWN effective default (used by tqnn_status/
            // ping() and any tool call that omits `dataset`) is resolved separately —
            // per employee in tqnn_mcp_credentials.json, or CONFIG.dataset (.env
            // TQNN_DATASET) as the final fallback — never by the ACL. Surface both so
            // a multi-dataset employee isn't left guessing which one their calls
            // actually hit when they don't pass `dataset` explicitly.
            mcp_effective_default_dataset: client.dataset || '(unset — falls through to DMM appliance default)',
            default_dataset_note: result.default_dataset_note,
            claude_connected: result.claude_connected,
            claude_model: result.claude_model,
            dmm_response: result.tqnn_response
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

// ── Tool: tqnn_search ─────────────────────────────────────────────────────────
server.tool(
  'tqnn_search',
  'Search the TQNN DMM associative memory for documents matching a pattern. Returns file references associated with the search terms. Use for targeted retrieval where query terms are specific and known.',
  {
    query: z.string().describe('The search term to query against DMM associative memory. Single token works best.'),
    dataset: z.string().optional().describe('Optional: target dataset/namespace to search within. Overrides server default.'),
    return_filelist: z.number().int().min(0).max(1).default(1).optional().describe('Set to 1 to return full filelist. Default 1.'),
    pqr: z.boolean().default(false).optional().describe('PQR-hash the query before searching. Default false, matching the DMM REST API and Workbench, where PQR is opt-in — set true to hash the query, and it must match how the target record was stored (tqnn_store pqr:true).'),
    hmac: z.boolean().default(false).optional().describe('When pqr:true, use the keyed HMAC construction instead of the unkeyed self-salting scheme. Default false — matches data ingested before this option existed (e.g. an existing corpus), no server key required. Set true only for data stored with tqnn_store pqr:true hmac:true; requires TQNN_PQR_KEY configured server-side, and will error clearly if missing. Ignored when pqr:false.'),
    fpd: z.boolean().default(false).optional().describe('Enable False Positive Defence — makes a second search on the reversed-input hash and returns only filereferences present in both, filtering out hash collisions. Default false, matching the API/Workbench default; set true for higher-confidence results at the cost of a second DMM call. Only applies when pqr:true (ignored, and reported as false, when pqr:false — there is no hash to reverse).')
  },
  async ({ query, dataset, return_filelist = 1, pqr = false, hmac = false, fpd = false }) => {
    try {
      const trimmed = query.trim();
      const hash = pqr ? pqrHash(trimmed, hmac) : trimmed;
      const result = await client.searchDoc(hash, dataset);
      let filelist = (result.filelist || '').split('\n').map(r => r.trim()).filter(Boolean);

      const fpdApplied = pqr && fpd;
      if (fpdApplied) {
        const revResult = await client.searchDoc(pqrHashReversed(trimmed, hmac), dataset);
        const revStripped = new Set(
          (revResult.filelist || '').split('\n').map(r => r.trim()).filter(Boolean).map(stripTimestamp)
        );
        filelist = filelist.filter(ref => revStripped.has(stripTimestamp(ref)));
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            pqr_enabled: pqr,
            hmac_enabled: pqr && hmac,
            pqr_hash: pqr ? hash : null,
            fpd_enabled: fpdApplied,
            result_count: filelist.length,
            filereferences: filelist,
            dmm_response: { code: result.code, type: result.type, message: result.message }
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

// ── Tool: tqnn_similarity ─────────────────────────────────────────────────────
server.tool(
  'tqnn_similarity',
  'Find documents in TQNN DMM that are semantically similar to a free-text input, using associative token overlap scoring. More powerful than tqnn_search for natural language queries — pass the user\'s question or a text excerpt directly. Returns ranked file references above a similarity threshold.',
  {
    text: z.string().describe('Free text to find similar documents for. Can be a question, sentence, paragraph, or keyword list.'),
    threshold: z.number().min(0).max(1).default(0.4).optional().describe('Token overlap threshold 0.0–1.0. Default 0.4 (40% of tokens must match).'),
    dataset: z.string().optional().describe('Optional: target dataset/namespace to search within.'),
    pqr: z.boolean().default(true).optional().describe('PQR-hash each token before searching. Default true. Set false to run plain (unhashed) similarity search — for records stored via tqnn_store pqr:false. Equivalent to calling tqnn_similarity_plain. Forces fpd off when false (there is no hash to reverse).'),
    hmac: z.boolean().default(false).optional().describe('When pqr:true, use the keyed HMAC construction instead of the unkeyed self-salting scheme. Default false — matches data ingested before this option existed (e.g. an existing corpus), no server key required. Set true only for data stored with tqnn_store pqr:true hmac:true; requires TQNN_PQR_KEY configured server-side, and will error clearly (not silently return zero matches) if missing. Ignored when pqr:false.'),
    fpd: z.boolean().default(true).optional().describe('Enable False Positive Defence. Default true. Recommended to leave on. Ignored, and reported as false, when pqr:false.'),
    max_results: z.number().int().min(1).max(100).default(20).optional().describe('Maximum number of file references to return. Default 20.'),
    parallel: z.boolean().default(false).optional().describe('Search all query tokens concurrently instead of one-at-a-time. Default false. Same results/ranking either way — only changes how many simultaneous requests hit the DMM appliance, so test against your appliance before enabling under load.')
  },
  async ({ text, threshold = 0.4, dataset, pqr = true, hmac = false, fpd = true, max_results = 20, parallel = false }) => {
    try {
      const result = await similaritySearch(client, text, {
        threshold,
        dataset: dataset || CONFIG.dataset,
        pqr,
        hmac,
        fpd,
        maxResults: max_results,
        parallel
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

// ── Tool: tqnn_similarity_plain ─────────────────────────────────────────────────
// Same weighted-overlap algorithm as tqnn_similarity, always in plain (unhashed)
// mode — equivalent to tqnn_similarity with pqr:false, exposed as its own tool
// for callers who want an explicitly plaintext-only entry point without needing
// to know the pqr flag exists. Works against data stored via tqnn_store pqr:false
// (or, per storeDoc.php's own tokenising, any data at all — DMM tokenises and
// keys every value server-side regardless of how it was submitted).
server.tool(
  'tqnn_similarity_plain',
  'Find documents in TQNN DMM that are similar to free-text input, using plain (unhashed) associative token overlap scoring. Same algorithm as tqnn_similarity, but searches raw tokens directly with no PQR hashing and no False Positive Defence — use for data stored via tqnn_store pqr:false, or when you specifically want plaintext-only search. Equivalent to tqnn_similarity with pqr:false.',
  {
    text: z.string().describe('Free text to find similar documents for. Can be a question, sentence, paragraph, or keyword list.'),
    threshold: z.number().min(0).max(1).default(0.4).optional().describe('Token overlap threshold 0.0–1.0. Default 0.4 (40% of tokens must match).'),
    dataset: z.string().optional().describe('Optional: target dataset/namespace to search within.'),
    max_results: z.number().int().min(1).max(100).default(20).optional().describe('Maximum number of file references to return. Default 20.'),
    parallel: z.boolean().default(false).optional().describe('Search all query tokens concurrently instead of one-at-a-time. Default false. Same results/ranking either way — only changes how many simultaneous requests hit the DMM appliance, so test against your appliance before enabling under load.')
  },
  async ({ text, threshold = 0.4, dataset, max_results = 20, parallel = false }) => {
    try {
      const result = await similaritySearch(client, text, {
        threshold,
        dataset: dataset || CONFIG.dataset,
        pqr: false,
        fpd: false,
        maxResults: max_results,
        parallel
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

// ── Tool: tqnn_store ──────────────────────────────────────────────────────────
server.tool(
  'tqnn_store',
  'Store a document reference and its metadata into TQNN DMM associative memory. Use when Claude needs to persist new knowledge associations during an agentic session.',
  {
    filereference: z.string().describe('URI or path to the document. Must end with :: e.g. memory://claude/session/2026-06-20::'),
    pattern: z.string().describe('JSON array of metadata objects e.g. [{"title":"Report","year":2024}]. Stored raw by default; set pqr:true to tokenise and PQR-hash field values before storage.'),
    dataset: z.string().optional().describe('Optional: target dataset/namespace.'),
    pqr: z.boolean().default(false).optional().describe('Enable PQR hashing of pattern field values before storage. Default false, matching the DMM REST API and Workbench, where PQR is opt-in. Must match search mode.'),
    hmac: z.boolean().default(false).optional().describe('When pqr:true, use the keyed HMAC construction instead of the unkeyed self-salting scheme. Default false, matching pre-existing ingested data (e.g. an existing corpus) — no server key required. Set true to start a migration to keyed tokens for NEW records; requires TQNN_PQR_KEY configured server-side. Must match hmac setting used on the corresponding search calls. Ignored when pqr:false.'),
    fpd: z.boolean().default(false).optional().describe('Enable False Positive Defence — stores both forward and reversed-input hashes per token. Default false, matching the API/Workbench default. Required for tqnn_similarity with fpd:true, and for tqnn_search with fpd:true.'),
    create_ots: z.boolean().default(false).optional().describe('Submit SHA-256 fingerprint to OpenTimestamps Bitcoin calendar for blockchain anchoring.')
  },
  async ({ filereference, pattern, dataset, pqr = false, hmac = false, fpd = false, create_ots = false }) => {
    try {
      // ── Parse and validate pattern ──────────────────────────────────────────
      let parsedPattern;
      try {
        parsedPattern = JSON.parse(pattern);
      } catch {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'pattern must be a valid JSON array string e.g. [{"title":"Report","year":2024}]' }, null, 2) }],
          isError: true
        };
      }
      if (!Array.isArray(parsedPattern)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'pattern must be a JSON array — wrap your object in [ ] e.g. [{"title":"Report","year":2024}]' }, null, 2) }],
          isError: true
        };
      }

      const ref = filereference.endsWith('::') ? filereference : filereference + '::';

      // ── Build storable pattern ──────────────────────────────────────────────
      // If pqr:true, tokenise every string field value and replace with
      // PQR-hashed tokens so the stored associations match what searchDoc expects.
      // Raw pattern is stored as-is when pqr:false (legacy / plain text mode).
      let storePattern;
      let fpdPattern = null;

      if (pqr) {
        // Collect all unique tokens across all field values in all objects
        const allTokens = new Set();
        for (const obj of parsedPattern) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'string') {
              const toks = tokenise(val);
              if (toks.length > 0) {
                for (const tok of toks) allTokens.add(tok);
              } else if (val.trim().length >= 4) {
                // tokenise() only extracts alphabetic runs (>= MIN_TOKEN_LENGTH),
                // so numeric-only or short-alnum strings (IMEIs, serials, IDs)
                // come back empty and would otherwise be silently dropped.
                // Fall back to storing the raw trimmed value as a single token,
                // matching how tqnn_search hashes its query (raw, untokenised).
                allTokens.add(val.trim());
              }
            } else if (val !== null && val !== undefined) {
              // Non-string scalars: stringify and treat as single token if long enough
              const s = String(val);
              if (s.length >= 4) allTokens.add(s);
            }
          }
        }

        // Forward store: hash each token, build pattern array DMM expects
        const fwdTokens = [...allTokens].map(tok => ({ token: pqrHash(tok, hmac) }));
        storePattern = JSON.stringify(fwdTokens);

        // FPD reverse store: reverse each token INPUT string before hashing
        if (fpd) {
          const revTokens = [...allTokens].map(tok => ({ token: pqrHashReversed(tok, hmac) }));
          fpdPattern = JSON.stringify(revTokens);
        }
      } else {
        // pqr:false — pass pattern straight through (raw mode)
        storePattern = pattern;
      }

      // ── Forward store ───────────────────────────────────────────────────────
      const fwdResult = await client.storeDoc(ref, storePattern, dataset, create_ots);
      const fwdOk = (fwdResult.tqnn_response || '').includes('STORE_OK');

      // ── FPD reverse store ───────────────────────────────────────────────────
      let revResult = null;
      let revOk = null;
      if (fpd && pqr && fpdPattern) {
        revResult = await client.storeDoc(ref, fpdPattern, dataset, false);
        revOk = (revResult.tqnn_response || '').includes('STORE_OK');
      }

      const success = fwdOk && (fpd ? revOk : true);

      // ── Register in-memory record for tqnn_get resolution this session ──────
      if (success) registerMemory(ref, pattern);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success,
            filereference: ref,
            pqr_enabled: pqr,
            hmac_enabled: pqr && hmac,
            fpd_enabled: fpd,
            tokens_stored: pqr ? JSON.parse(storePattern).length : null,
            forward_store: { ok: fwdOk, dmm_response: fwdResult },
            ...(fpd && pqr ? { reverse_store: { ok: revOk, dmm_response: revResult } } : {})
          }, null, 2)
        }],
        isError: !success
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

// ── Tool: tqnn_get ────────────────────────────────────────────────────────────
server.tool(
  'tqnn_get',
  [
    'Retrieve a document or resource identified by a TQNN DMM filereference.',
    'Three operations:',
    '  ping  — check if the resource exists and is reachable (fast, no content returned)',
    '  info  — get metadata: size, content type, last modified, resolver type (no content body)',
    '  fetch — retrieve full content (text inline or base64 for binary; large files auto-zipped)',
    'Always call ping or info before fetch for large or cold resources.',
    'Filereferences are returned by tqnn_search and tqnn_similarity.',
    'Resolution is handled by developer-configured resolvers in tqnn_resolvers.json.',
    'DMM never holds file content — only associations. Content lives in developer infrastructure.'
  ].join('\n'),
  {
    filereference: z.string().describe(
      'The filereference to resolve — as returned by tqnn_search or tqnn_similarity. ' +
      'Examples: "memory://claude/session/2026-06-20::", "records_0001.jsonl::line28::", ' +
      '"https://example.com/report.pdf::", "glacier://archive/2024/Q1/batch::". ' +
      'DMM-appended timestamps (::1782281928) are stripped automatically.'
    ),
    operation: z.enum(['ping', 'info', 'fetch']).default('ping').describe(
      'What to do: "ping" = exists check only | "info" = metadata only | "fetch" = full content retrieval'
    ),
    dataset: z.string().optional().describe(
      'Optional: dataset context hint — passed through to webhook resolvers for scoping.'
    )
  },
  async ({ filereference, operation = 'ping', dataset }) => {
    try {
      const result = await resolverDispatch(filereference, operation, dataset);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }],
        isError: ['ERROR', 'NO_RESOLVER', 'WEBHOOK_UNREACHABLE', 'WEBHOOK_ERROR', 'HTTP_ERROR', 'UNREACHABLE'].includes(result.status)
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'ERROR', message: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

  return server;
}

// ── Transport ──────────────────────────────────────────────────────────────────
async function startServer() {
  if (CONFIG.mode === 'sse') {
    await startSSE();
  } else {
    await startStdio();
  }
}

// ── stdio mode ─────────────────────────────────────────────────────────────────
async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[tqnn-mcp] Running in stdio mode. Ready for Claude Code.\n');
}

// ── SSE mode ───────────────────────────────────────────────────────────────────
async function startSSE() {
  const http = require('http');
  const crypto = require('crypto');
  const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');

  // ── OAuth setup ──────────────────────────────────────────────────────────────
  if (!CONFIG.publicUrl) {
    process.stderr.write('[tqnn-mcp] WARNING: TQNN_PUBLIC_URL not set — OAuth discovery will use http://localhost:<port>.\n');
    process.stderr.write('[tqnn-mcp]          Set TQNN_PUBLIC_URL=https://<ngrok-url> in .env for claude.ai to work.\n');
  }
  if (!CONFIG.mcpSecret || CONFIG.mcpSecret.length < 32) {
    process.stderr.write('[tqnn-mcp] ERROR: TQNN_MCP_SECRET must be set (≥32 chars). Generate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"\n');
    process.exit(1);
  }
  if (!CONFIG.oauthPass) {
    process.stderr.write('[tqnn-mcp] ERROR: TQNN_OAUTH_PASS must be set in .env (password for the consent screen).\n');
    process.exit(1);
  }

  const publicBase = CONFIG.publicUrl || `http://localhost:${CONFIG.port}`;

  const oauth = new OAuthServer({
    publicUrl:  publicBase,
    secret:     CONFIG.mcpSecret,
    adminUser:  CONFIG.oauthUser,
    adminPass:  CONFIG.oauthPass,
  });

  const sessions = new Map(); // sessionId → { transport, mcpServer }  (legacy /sse + /messages — DMM Workbench)
  const streamableSessions = new Map(); // sessionId → { transport, mcpServer }  (/mcp — claude.ai connector)

  const httpServer = http.createServer(async (req, res) => {
    // ── CORS ──────────────────────────────────────────────────────────────────
    // Restrict to claude.ai in production; keep * for ngrok tunnel compatibility.
    const corsOrigin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, mcp-session-id, mcp-protocol-version');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url || '/';

    // ── Health check ──────────────────────────────────────────────────────────
    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        server: 'tqnn-mcp-server',
        version: '1.9.0',
        auth: 'oauth2.1',
        base_url: CONFIG.baseUrl,
        dataset: CONFIG.dataset || '(default)'
      }));
      return;
    }

    // ── RFC 9728: Protected Resource Metadata ─────────────────────────────────
    if ((url === '/.well-known/oauth-protected-resource' ||
         url.startsWith('/.well-known/oauth-protected-resource/')) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(oauth.protectedResourceMetadata()));
      return;
    }

    // ── RFC 8414: Authorization Server Metadata ───────────────────────────────
    if (url === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(oauth.authorizationServerMetadata()));
      return;
    }

    // ── RFC 7591: Dynamic Client Registration ─────────────────────────────────
    if (url === '/oauth/register' && req.method === 'POST') {
      const body = await readBody(req);
      const result = oauth.registerClient(body);
      const status = result.error ? 400 : 201;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ── Authorization endpoint ─────────────────────────────────────────────────
    if (url.startsWith('/oauth/authorize')) {
      if (req.method === 'GET') {
        const { URL: NodeURL } = require('url');
        const parsed  = new NodeURL(url, `http://localhost`);
        const query   = {};
        for (const [k, v] of parsed.searchParams) query[k] = v;
        const result = oauth.handleAuthorizeRequest(query);

        if (result.action === 'render_form') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(result.html);
        } else {
          res.writeHead(result.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error, error_description: result.error_description }));
        }
        return;
      }

      if (req.method === 'POST') {
        const body   = await readBody(req);
        const result = oauth.handleAuthorizeSubmit(body);

        if (result.action === 'redirect') {
          res.writeHead(302, { Location: result.location });
          res.end();
        } else if (result.action === 'render_form') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(result.html);
        } else {
          res.writeHead(result.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error }));
        }
        return;
      }
    }

    // ── Token endpoint ─────────────────────────────────────────────────────────
    if (url === '/oauth/token' && req.method === 'POST') {
      const body   = await readBody(req);
      const result = oauth.handleTokenRequest(body);
      const status = result.error ? 400 : 200;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache'
      });
      res.end(JSON.stringify(result));
      return;
    }

    // ── SSE endpoint ───────────────────────────────────────────────────────────
    // All MCP endpoints require a valid Bearer token.
    if (url === '/sse' && req.method === 'GET') {
      const authResult = oauth.validateToken(req.headers['authorization'] || '');
      if (!authResult.valid) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer resource_metadata="${publicBase}/.well-known/oauth-protected-resource"`
        });
        res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Valid Bearer token required' }));
        return;
      }

      process.stderr.write(`[tqnn-mcp] New SSE connection (client: ${authResult.client_id}, user: ${authResult.username || 'n/a'}) from ${req.socket.remoteAddress}\n`);
      const transport = new SSEServerTransport('/messages', res);
      const mcpServer = createMcpServer(authResult);
      sessions.set(transport.sessionId, { transport, mcpServer });

      res.on('close', () => {
        sessions.delete(transport.sessionId);
        mcpServer.close?.();
        process.stderr.write(`[tqnn-mcp] SSE connection closed (session ${transport.sessionId})\n`);
      });

      await mcpServer.connect(transport);
      return;
    }

    // ── Streamable HTTP endpoint (current MCP spec, 2025-06-18) ────────────────
    // This is what claude.ai's connector UI speaks. The legacy /sse + /messages
    // pair below is kept as-is for DMM Workbench and anything else still using
    // the old two-endpoint HTTP+SSE transport — both can run side by side.
    if (url === '/mcp' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
      const authResult = oauth.validateToken(req.headers['authorization'] || '');
      if (!authResult.valid) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer resource_metadata="${publicBase}/.well-known/oauth-protected-resource"`
        });
        res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Valid Bearer token required' }));
        return;
      }

      const sessionId = req.headers['mcp-session-id'];

      if (req.method === 'POST') {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', async () => {
          let parsedBody;
          try {
            parsedBody = raw ? JSON.parse(raw) : undefined;
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
            return;
          }

          try {
            const existing = sessionId ? streamableSessions.get(sessionId) : null;

            if (existing) {
              await existing.transport.handleRequest(req, res, parsedBody);
              return;
            }

            if (!sessionId && isInitializeRequest(parsedBody)) {
              const mcpServer = createMcpServer(authResult);
              const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: (sid) => {
                  streamableSessions.set(sid, { transport, mcpServer });
                  process.stderr.write(`[tqnn-mcp] New Streamable HTTP session (client: ${authResult.client_id}, user: ${authResult.username || 'n/a'}, session: ${sid})\n`);
                }
              });
              transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && streamableSessions.has(sid)) {
                  streamableSessions.delete(sid);
                  mcpServer.close?.();
                  process.stderr.write(`[tqnn-mcp] Streamable HTTP session closed (${sid})\n`);
                }
              };
              await mcpServer.connect(transport);
              await transport.handleRequest(req, res, parsedBody);
              return;
            }

            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
              id: null
            }));
          } catch (err) {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null }));
            }
          }
        });
        return;
      }

      // GET (standalone SSE stream for server-initiated notifications) and
      // DELETE (explicit session termination) both need an existing session.
      const existing = sessionId ? streamableSessions.get(sessionId) : null;
      if (!existing) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_session', error_description: 'No active session for this ID' }));
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    // ── Messages endpoint ──────────────────────────────────────────────────────
    if (url?.startsWith('/messages') && req.method === 'POST') {
      const authResult = oauth.validateToken(req.headers['authorization'] || '');
      if (!authResult.valid) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer resource_metadata="${publicBase}/.well-known/oauth-protected-resource"`
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const { URL: NodeURL } = require('url');
      const urlObj    = new NodeURL(url, `http://localhost:${CONFIG.port}`);
      const sessionId = urlObj.searchParams.get('sessionId');
      const session   = sessions.get(sessionId);

      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Session ${sessionId} not found` }));
        return;
      }
      const { transport } = session;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          await transport.handlePostMessage(req, res, JSON.parse(body));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── 404 ────────────────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Not found',
      available: ['/mcp', '/sse', '/messages', '/health',
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-authorization-server',
        '/oauth/register', '/oauth/authorize', '/oauth/token']
    }));
  });

  httpServer.listen(CONFIG.port, () => {
    process.stderr.write(`[tqnn-mcp] Running in SSE mode on port ${CONFIG.port}\n`);
    process.stderr.write(`[tqnn-mcp] Public URL   : ${publicBase}\n`);
    process.stderr.write(`[tqnn-mcp] MCP endpoint : ${publicBase}/mcp  (use this in claude.ai connector settings)\n`);
    process.stderr.write(`[tqnn-mcp] SSE endpoint : ${publicBase}/sse  (legacy — DMM Workbench only)\n`);
    process.stderr.write(`[tqnn-mcp] Health check : ${publicBase}/health\n`);
    process.stderr.write(`[tqnn-mcp] OAuth AS     : ${publicBase}/.well-known/oauth-authorization-server\n`);
    process.stderr.write(`[tqnn-mcp] DMM base URL : ${CONFIG.baseUrl}\n`);
    process.stderr.write(`[tqnn-mcp] Dataset      : ${CONFIG.dataset || '(default)'}\n`);
  });
}

startServer().catch(err => {
  process.stderr.write(`[tqnn-mcp] Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
