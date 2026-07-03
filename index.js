// index.js — TQNN DMM MCP Server
// TQNN MCP Server v1.3.1
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
const { similaritySearch, pqrHash, pqrHashReversed, tokenise } = require('./similarity');
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
  mcpSecret:  process.env.TQNN_MCP_SECRET  || '',   // HMAC secret for token signing
  oauthUser:  process.env.TQNN_OAUTH_USER  || 'admin',
  oauthPass:  process.env.TQNN_OAUTH_PASS  || '',   // plaintext from .env, hashed immediately
};

if (!CONFIG.apiKey || !CONFIG.apiSecret) {
  process.stderr.write('[tqnn-mcp] WARNING: TQNN_API_KEY or TQNN_API_SECRET not set\n');
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

  const cacheKey = `${apiKey}:${apiSecret}`;
  if (!_clientCache.has(cacheKey)) {
    _clientCache.set(cacheKey, new TQNNClient({
      baseUrl:   CONFIG.baseUrl,
      apiKey,
      apiSecret,
      dataset:   CONFIG.dataset
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
    version: '1.4.0'
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

// ── Tool: tqnn_search ─────────────────────────────────────────────────────────
server.tool(
  'tqnn_search',
  'Search the TQNN DMM associative memory for documents matching a pattern. Returns file references associated with the search terms. Use for targeted retrieval where query terms are specific and known.',
  {
    query: z.string().describe('The search term to query against DMM associative memory. Single token works best — the term is PQR-hashed before searching.'),
    dataset: z.string().optional().describe('Optional: target dataset/namespace to search within. Overrides server default.'),
    return_filelist: z.number().int().min(0).max(1).default(1).optional().describe('Set to 1 to return full filelist. Default 1.')
  },
  async ({ query, dataset, return_filelist = 1 }) => {
    try {
      const hash = pqrHash(query.trim());
      const result = await client.searchDoc(hash, dataset);
      const filelist = (result.filelist || '').split('\n').map(r => r.trim()).filter(Boolean);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            pqr_hash: hash,
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
    fpd: z.boolean().default(true).optional().describe('Enable False Positive Defence. Default true. Recommended to leave on.'),
    max_results: z.number().int().min(1).max(100).default(20).optional().describe('Maximum number of file references to return. Default 20.')
  },
  async ({ text, threshold = 0.4, dataset, fpd = true, max_results = 20 }) => {
    try {
      const result = await similaritySearch(client, text, {
        threshold,
        dataset: dataset || CONFIG.dataset,
        fpd,
        maxResults: max_results
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
    pattern: z.string().describe('JSON array of metadata objects e.g. [{"title":"Report","year":2024}]. Field values are tokenised and PQR-hashed before storage.'),
    dataset: z.string().optional().describe('Optional: target dataset/namespace.'),
    pqr: z.boolean().default(true).optional().describe('Enable PQR hashing of pattern field values before storage. Default true. Must match search mode.'),
    fpd: z.boolean().default(true).optional().describe('Enable False Positive Defence — stores both forward and reversed-input hashes per token. Default true. Required for tqnn_similarity with fpd:true.'),
    create_ots: z.boolean().default(false).optional().describe('Submit SHA-256 fingerprint to OpenTimestamps Bitcoin calendar for blockchain anchoring.')
  },
  async ({ filereference, pattern, dataset, pqr = true, fpd = true, create_ots = false }) => {
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
              for (const tok of tokenise(val)) allTokens.add(tok);
            } else if (val !== null && val !== undefined) {
              // Non-string scalars: stringify and treat as single token if long enough
              const s = String(val);
              if (s.length >= 4) allTokens.add(s);
            }
          }
        }

        // Forward store: hash each token, build pattern array DMM expects
        const fwdTokens = [...allTokens].map(tok => ({ token: pqrHash(tok) }));
        storePattern = JSON.stringify(fwdTokens);

        // FPD reverse store: reverse each token INPUT string before hashing
        if (fpd) {
          const revTokens = [...allTokens].map(tok => ({ token: pqrHashReversed(tok) }));
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
  const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');

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

  const sessions = new Map(); // sessionId → { transport, mcpServer }

  const httpServer = http.createServer(async (req, res) => {
    // ── CORS ──────────────────────────────────────────────────────────────────
    // Restrict to claude.ai in production; keep * for ngrok tunnel compatibility.
    const corsOrigin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, mcp-session-id');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url || '/';

    // ── Health check ──────────────────────────────────────────────────────────
    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        server: 'tqnn-mcp-server',
        version: '1.4.0',
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
      available: ['/sse', '/messages', '/health',
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-authorization-server',
        '/oauth/register', '/oauth/authorize', '/oauth/token']
    }));
  });

  httpServer.listen(CONFIG.port, () => {
    process.stderr.write(`[tqnn-mcp] Running in SSE mode on port ${CONFIG.port}\n`);
    process.stderr.write(`[tqnn-mcp] Public URL   : ${publicBase}\n`);
    process.stderr.write(`[tqnn-mcp] SSE endpoint : ${publicBase}/sse\n`);
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
