// index.js — TQNN DMM MCP Server
// TQNN MCP Server v1.0.0
//
// Exposes TQNN DMM associative memory as MCP tools for Claude and other
// MCP-compatible LLMs.
//
// Modes:
//   stdio — for Claude Code integration (default)
//   SSE   — for claude.ai MCP connector and remote deployments
//
// Start:
//   MCP_MODE=stdio node index.js
//   MCP_MODE=sse   node index.js

// ── Load .env ───────────────────────────────────────────────────────────────
try {
  const fs = require('fs');
  const env = fs.readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (m) {
      const key = m[1].trim();
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val; // don't override shell env
    }
  }
} catch { /* .env optional */ }

// ── TLS (tqnn.local self-signed cert) ───────────────────────────────────────
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
}

// ── Dependencies ─────────────────────────────────────────────────────────────
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { TQNNClient } = require('./tqnn-client');
const { similaritySearch, pqrHash } = require('./similarity');

// ── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:   process.env.TQNN_BASE_URL    || 'https://tqnn.local',
  apiKey:    process.env.TQNN_API_KEY     || '',
  apiSecret: process.env.TQNN_API_SECRET  || '',
  dataset:   process.env.TQNN_DATASET     || '',
  mode:      (process.env.MCP_MODE        || 'stdio').toLowerCase(),
  port:      parseInt(process.env.MCP_PORT || '3100', 10)
};

if (!CONFIG.apiKey || !CONFIG.apiSecret) {
  process.stderr.write('[tqnn-mcp] WARNING: TQNN_API_KEY or TQNN_API_SECRET not set\n');
}

const client = new TQNNClient({
  baseUrl:   CONFIG.baseUrl,
  apiKey:    CONFIG.apiKey,
  apiSecret: CONFIG.apiSecret,
  dataset:   CONFIG.dataset
});

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'tqnn-dmm',
  version: '1.0.0'
});

// ── Tool: tqnn_status ────────────────────────────────────────────────────────
// Lightweight ping to confirm DMM connectivity.
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
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'error', message: err.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// ── Tool: tqnn_search ────────────────────────────────────────────────────────
// Single searchDoc call — fast, exact associative pattern match.
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
      const hash = pqrHash(query.trim().toLowerCase());
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

// ── Tool: tqnn_similarity ────────────────────────────────────────────────────
// Multi-call orchestration — passes free text, returns ranked similar documents.
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

// ── Tool: tqnn_store ─────────────────────────────────────────────────────────
// Wraps storeDoc — allows Claude to write new associations into DMM.
server.tool(
  'tqnn_store',
  'Store a document reference and its metadata into TQNN DMM associative memory. Use when Claude needs to persist new knowledge associations during an agentic session.',
  {
    filereference: z.string().describe('URI or path to the document. Must end with :: e.g. url://server/path/file.pdf::'),
    pattern: z.string().describe('JSON string of document metadata e.g. {"title":"Report","year":2024}'),
    dataset: z.string().optional().describe('Optional: target dataset/namespace.'),
    create_ots: z.boolean().default(false).optional().describe('Submit SHA-256 fingerprint to OpenTimestamps Bitcoin calendar for blockchain anchoring.')
  },
  async ({ filereference, pattern, dataset, create_ots = false }) => {
    try {
      // Validate pattern is parseable JSON and is a JSON array
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

      // Ensure filereference ends with ::
      const ref = filereference.endsWith('::') ? filereference : filereference + '::';
      const result = await client.storeDoc(ref, pattern, dataset, create_ots);
      const success = (result.message || '').includes('STORE_OK');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success,
            filereference: ref,
            dmm_response: result
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

// ── Transport ─────────────────────────────────────────────────────────────────
async function startServer() {
  if (CONFIG.mode === 'sse') {
    await startSSE();
  } else {
    await startStdio();
  }
}

// ── stdio mode ────────────────────────────────────────────────────────────────
async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[tqnn-mcp] Running in stdio mode. Ready for Claude Code.\n');
}

// ── SSE mode ──────────────────────────────────────────────────────────────────
async function startSSE() {
  const http = require('http');
  const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');

  const transports = new Map(); // sessionId → SSEServerTransport

  const httpServer = http.createServer(async (req, res) => {
    // CORS — required for claude.ai browser-based MCP connector
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        server: 'tqnn-mcp-server',
        version: '1.0.0',
        base_url: CONFIG.baseUrl,
        dataset: CONFIG.dataset || '(default)'
      }));
      return;
    }

    // SSE connection endpoint
    if (req.url === '/sse' && req.method === 'GET') {
      process.stderr.write(`[tqnn-mcp] New SSE connection from ${req.socket.remoteAddress}\n`);
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);

      res.on('close', () => {
        transports.delete(transport.sessionId);
        process.stderr.write(`[tqnn-mcp] SSE connection closed (session ${transport.sessionId})\n`);
      });

      await server.connect(transport);
      return;
    }

    // Message endpoint (MCP client posts here)
    if (req.url?.startsWith('/messages') && req.method === 'POST') {
      const urlObj = new URL(req.url, `http://localhost:${CONFIG.port}`);
      const sessionId = urlObj.searchParams.get('sessionId');
      const transport = transports.get(sessionId);

      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Session ${sessionId} not found` }));
        return;
      }

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

    // 404 for anything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', available: ['/sse', '/messages', '/health'] }));
  });

  httpServer.listen(CONFIG.port, () => {
    process.stderr.write(`[tqnn-mcp] Running in SSE mode on port ${CONFIG.port}\n`);
    process.stderr.write(`[tqnn-mcp] SSE endpoint : http://localhost:${CONFIG.port}/sse\n`);
    process.stderr.write(`[tqnn-mcp] Health check : http://localhost:${CONFIG.port}/health\n`);
    process.stderr.write(`[tqnn-mcp] DMM base URL : ${CONFIG.baseUrl}\n`);
    process.stderr.write(`[tqnn-mcp] Dataset      : ${CONFIG.dataset || '(default)'}\n`);
  });
}

startServer().catch(err => {
  process.stderr.write(`[tqnn-mcp] Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
