// mcp-test.js — MCP protocol test
// Run with: node mcp-test.js
//
// Spawns index.js as a child process and speaks the real MCP JSON-RPC protocol
// over stdio. Proves the MCP layer works before handing to Claude.
//
// Tests:
//   1. initialize    — handshake
//   2. tools/list    — confirm all 4 tools visible
//   3. tools/call    — tqnn_status (ping via MCP)
//   4. tools/call    — tqnn_search (single token via MCP)
//   5. tools/call    — tqnn_similarity (full end-to-end via MCP)

const { spawn } = require('child_process');
const path = require('path');

// ── Spawn the MCP server ─────────────────────────────────────────────────────
const server = spawn('node', [path.join(__dirname, 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
});

server.stderr.on('data', d => {
  process.stderr.write(`[server] ${d}`);
});

server.on('error', err => {
  console.error('✗ Failed to spawn index.js:', err.message);
  process.exit(1);
});

// ── JSON-RPC over stdio ───────────────────────────────────────────────────────
let msgId = 1;
let buffer = '';
const pending = new Map(); // id → { resolve, reject }

server.stdout.on('data', chunk => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete line
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    } catch (e) {
      // non-JSON line from server — ignore
    }
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    server.stdin.write(msg + '\n');
    // Timeout after 15s
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to "${method}"`));
      }
    }, 15000);
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────
function hr(label) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
}

function pass(msg) { console.log(`✓ ${msg}`); }
function fail(msg) { console.error(`✗ ${msg}`); }

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       TQNN DMM MCP Server — Protocol Test Suite         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // Give server a moment to start
  await new Promise(r => setTimeout(r, 500));

  // ── Test 1: initialize ──────────────────────────────────────────────────
  hr('Test 1: MCP initialize handshake');
  try {
    const result = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'mcp-test', version: '1.0.0' }
    });
    pass(`Server: ${result.serverInfo?.name} v${result.serverInfo?.version}`);
    pass(`Protocol: ${result.protocolVersion}`);

    // Send initialized notification
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  } catch (e) {
    fail(`initialize failed: ${e.message}`);
    shutdown(1); return;
  }

  // ── Test 2: tools/list ──────────────────────────────────────────────────
  hr('Test 2: tools/list — confirm all tools visible');
  try {
    const result = await send('tools/list');
    const tools = result.tools || [];
    const names = tools.map(t => t.name);
    console.log(`  Tools found: [${names.join(', ')}]`);

    const expected = ['tqnn_status', 'tqnn_search', 'tqnn_similarity', 'tqnn_store'];
    const missing = expected.filter(n => !names.includes(n));
    if (missing.length === 0) {
      pass(`All ${expected.length} tools registered`);
    } else {
      fail(`Missing tools: ${missing.join(', ')}`);
    }

    // Print descriptions
    tools.forEach(t => console.log(`  • ${t.name}: ${t.description?.slice(0, 70)}...`));
  } catch (e) {
    fail(`tools/list failed: ${e.message}`);
  }

  // ── Test 3: tqnn_status ─────────────────────────────────────────────────
  hr('Test 3: tools/call — tqnn_status (ping via MCP)');
  try {
    const result = await send('tools/call', {
      name: 'tqnn_status',
      arguments: {}
    });
    const text = result.content?.[0]?.text;
    const parsed = JSON.parse(text);
    if (parsed.status === 'ok') {
      pass(`DMM reachable via MCP: ${parsed.base_url}`);
      pass(`Dataset: ${parsed.dataset}`);
    } else {
      fail(`tqnn_status returned error: ${parsed.message}`);
    }
  } catch (e) {
    fail(`tqnn_status failed: ${e.message}`);
  }

  // ── Test 4: tqnn_search ─────────────────────────────────────────────────
  hr('Test 4: tools/call — tqnn_search (single token via MCP)');
  try {
    const result = await send('tools/call', {
      name: 'tqnn_search',
      arguments: { query: 'diabetes' }
    });
    const text = result.content?.[0]?.text;
    const parsed = JSON.parse(text);
    pass(`Query: "${parsed.query}"`);
    pass(`PQR hash: ${parsed.pqr_hash?.slice(0, 16)}...`);
    pass(`Results: ${parsed.result_count} filereference(s)`);
    if (parsed.filereferences?.length > 0) {
      console.log(`  First: ${parsed.filereferences[0]}`);
    }
  } catch (e) {
    fail(`tqnn_search failed: ${e.message}`);
  }

  // ── Test 5: tqnn_similarity ─────────────────────────────────────────────
  hr('Test 5: tools/call — tqnn_similarity (full end-to-end via MCP)');
  try {
    const result = await send('tools/call', {
      name: 'tqnn_similarity',
      arguments: {
        text: 'myocardial infarction',
        threshold: 0.4,
        fpd: true,
        max_results: 5
      }
    });
    const text = result.content?.[0]?.text;
    const parsed = JSON.parse(text);
    pass(`Tokens: [${parsed.tokens_used?.join(', ')}]`);
    pass(`Searched: ${parsed.tokens_searched} tokens`);
    pass(`Matches: ${parsed.matches_found} (threshold: ${parsed.threshold_pct}%)`);
    if (parsed.results?.length > 0) {
      console.log('  Top results:');
      parsed.results.slice(0, 3).forEach((r, i) => {
        console.log(`    ${i + 1}. ${r.filereference} (${r.overlap_pct}% overlap)`);
      });
    }
    if (parsed.matches_found > 0) {
      pass('Full MCP → DMM round-trip working');
    } else {
      fail('No matches returned — check dataset');
    }
  } catch (e) {
    fail(`tqnn_similarity failed: ${e.message}`);
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  MCP protocol test complete.');
  console.log('  If all tests pass, the server is ready for Claude.');
  console.log('═'.repeat(60) + '\n');

  shutdown(0);
}

function shutdown(code) {
  server.stdin.end();
  server.kill();
  process.exit(code);
}

main().catch(err => {
  console.error('\n✗ Unhandled error:', err);
  shutdown(1);
});
