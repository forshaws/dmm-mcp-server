// test.js — Direct DMM connectivity test
// Run with: node test.js
// Tests DMM ping, searchDoc, and similarity search directly.
// No MCP protocol involved — use this to validate the stack before wiring MCP.
//
// Usage:
//   node test.js
//   TQNN_BASE_URL=https://dmm.toridion.com node test.js   (production)

// tqnn.local uses a self-signed cert — disable TLS verification for local dev only.
// This is automatically skipped when NODE_TLS_REJECT_UNAUTHORIZED is not 0.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
  // Load .env if present
  try {
    const fs = require('fs');
    const env = fs.readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
}

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  console.warn('⚠️  TLS verification disabled (tqnn.local self-signed cert mode)\n');
}

const { TQNNClient } = require('./tqnn-client');
const { similaritySearch, pqrHash } = require('./similarity');

const client = new TQNNClient({
  baseUrl:   process.env.TQNN_BASE_URL    || 'https://tqnn.local',
  apiKey:    process.env.TQNN_API_KEY     || 'YOUR_KEY_HERE',
  apiSecret: process.env.TQNN_API_SECRET  || 'YOUR_SECRET_HERE',
  dataset:   process.env.TQNN_DATASET     || ''
});

function hr(label) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        TQNN DMM MCP Server — Direct Test Suite          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Base URL : ${process.env.TQNN_BASE_URL || 'https://tqnn.local'}`);
  console.log(`  Dataset  : ${process.env.TQNN_DATASET || '(default)'}`);

  // ── Test 1: Ping ──────────────────────────────────────────────────────────
  hr('Test 1: Ping DMM');
  try {
    const pong = await client.ping();
    console.log('✓ DMM connected');
    console.log('  Response:', JSON.stringify(pong));
  } catch (e) {
    console.error('✗ DMM ping FAILED:', e.message);
    console.error('  Check TQNN_BASE_URL, credentials, and network connectivity.');
    process.exit(1);
  }

  // ── Test 2: Single searchDoc call ─────────────────────────────────────────
  hr('Test 2: tqnn_search (single searchDoc call)');
  const testToken = 'patient';
  const hash = pqrHash(testToken);
  console.log(`  Token    : "${testToken}"`);
  console.log(`  PQR hash : ${hash}`);
  try {
    const searchResult = await client.searchDoc(hash);
    const filelist = (searchResult.filelist || '').split('\n').filter(Boolean);
    console.log(`✓ searchDoc returned ${filelist.length} filereference(s)`);
    if (filelist.length > 0) {
      console.log('  First result:', filelist[0]);
    }
    if (filelist.length > 3) {
      console.log(`  ... and ${filelist.length - 1} more`);
    }
  } catch (e) {
    console.error('✗ searchDoc FAILED:', e.message);
  }

  // ── Test 3: Similarity search ─────────────────────────────────────────────
  hr('Test 3: tqnn_similarity (multi-call orchestration)');
const testQueries = [
  'diabetes mellitus',           // 663 records combined — highest frequency
  'ischaemic heart disease',     // 204 records
  'malignant neoplasm breast',   // 188 records  
  'myocardial infarction',       // 194 records
  'deep vein thrombosis'         // 181 records
];

  for (const query of testQueries) {
    console.log(`\n  Query: "${query}"`);
    try {
      const result = await similaritySearch(client, query, {
        threshold: 0.4,
        fpd: true,
        maxResults: 5,
        dataset: process.env.TQNN_DATASET || ''
      });
      console.log(`  Tokens used  : [${result.tokens_used.join(', ')}]`);
      console.log(`  Searched     : ${result.tokens_searched} tokens`);
      console.log(`  Matches      : ${result.matches_found} (threshold: ${result.threshold_pct}%)`);
      if (result.results.length > 0) {
        console.log('  Top results:');
        result.results.slice(0, 3).forEach((r, i) => {
          console.log(`    ${i + 1}. ${r.filereference} (${r.overlap_pct}% overlap, ${r.token_hits} hits)`);
        });
      }
    } catch (e) {
      console.error(`  ✗ FAILED: ${e.message}`);
    }
  }

  // ── Test 4: FPD comparison ────────────────────────────────────────────────
  hr('Test 4: FPD comparison (FPD on vs off)');
  const fpdQuery = 'diabetes mellitus';
  console.log(`  Query: "${fpdQuery}"\n`);
  try {
    const withFpd    = await similaritySearch(client, fpdQuery, { threshold: 0.3, fpd: true,  maxResults: 10, dataset: process.env.TQNN_DATASET || '' });
    const withoutFpd = await similaritySearch(client, fpdQuery, { threshold: 0.3, fpd: false, maxResults: 10, dataset: process.env.TQNN_DATASET || '' });
    console.log(`  FPD ON  → ${withFpd.matches_found} matches`);
    console.log(`  FPD OFF → ${withoutFpd.matches_found} matches`);
    const filtered = withoutFpd.matches_found - withFpd.matches_found;
    console.log(`  False positives filtered by FPD: ${filtered >= 0 ? filtered : 'N/A'}`);
  } catch (e) {
    console.error('  ✗ FAILED:', e.message);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  Test suite complete.');
  console.log('  If all tests pass, proceed to: node index.js');
  console.log('═'.repeat(60) + '\n');
}

main().catch(err => {
  console.error('\n✗ Unhandled error:', err);
  process.exit(1);
});
