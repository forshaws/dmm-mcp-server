// resolver-test.js — Standalone test for tqnn_get resolver module
// Run with: node resolver-test.js
//
// Tests all three operations (ping/info/fetch) against all built-in handlers.
// No MCP stack or DMM connection required — this tests the resolver layer only.
//
// Uses synthetic test data where disk reads are needed.

const { resolverDispatch, registerMemory, loadConfig, normaliseRef } = require('./resolver');
const fs   = require('fs');
const path = require('path');

// ── Colour helpers ────────────────────────────────────────────────────────────
const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`
};

let passed = 0;
let failed = 0;
let warned = 0;

function hr(label) {
  console.log(`\n${c.cyan('─'.repeat(65))}`);
  console.log(c.bold(`  ${label}`));
  console.log(c.cyan('─'.repeat(65)));
}

function check(label, result, expectStatus, options = {}) {
  const { warn = false, showResult = false } = options;
  const ok = result.status === expectStatus;
  if (ok) {
    console.log(`  ${c.green('✓')} ${label} ${c.dim(`→ ${result.status}`)}`);
    passed++;
  } else if (warn) {
    console.log(`  ${c.yellow('⚠')} ${label} ${c.dim(`→ ${result.status}`)} (expected ${expectStatus} — may be environment-specific)`);
    warned++;
  } else {
    console.log(`  ${c.red('✗')} ${label}`);
    console.log(`    Expected: ${expectStatus}`);
    console.log(`    Got     : ${result.status}`);
    if (result.message) console.log(`    Message : ${result.message}`);
    failed++;
  }
  if (showResult) {
    console.log(c.dim('    Result:'));
    const lines = JSON.stringify(result, null, 2).split('\n');
    for (const l of lines.slice(0, 20)) console.log(c.dim(`      ${l}`));
    if (lines.length > 20) console.log(c.dim(`      ... (${lines.length - 20} more lines)`));
  }
  return ok;
}

async function main() {
  console.log(c.bold('\n╔══════════════════════════════════════════════════════════════╗'));
  console.log(c.bold(  '║         tqnn_get Resolver — Test Suite                      ║'));
  console.log(c.bold(  '╚══════════════════════════════════════════════════════════════╝'));

  // ── Test 0: Config load ────────────────────────────────────────────────────
  hr('Test 0: Config load');
  let cfg;
  try {
    cfg = loadConfig();
    const schemes = cfg.resolvers.map(r => r.scheme).join(', ');
    console.log(`  ${c.green('✓')} Config loaded — ${cfg.resolvers.length} resolvers: ${c.dim(schemes)}`);
    passed++;
  } catch (e) {
    console.log(`  ${c.red('✗')} Config load failed: ${e.message}`);
    failed++;
    process.exit(1);
  }

  // ── Test 1: normaliseRef ────────────────────────────────────────────────────
  hr('Test 1: normaliseRef utility');
  const cases = [
    ['memory://claude/test/brahma-2026-06-24::1782281928', 'memory://claude/test/brahma-2026-06-24::'],
    ['memory://claude/test/brahma-2026-06-24::',           'memory://claude/test/brahma-2026-06-24::'],
    ['records_0001.jsonl::line28::REC-00010028::1782123456', 'records_0001.jsonl::line28::REC-00010028::'],
    ['https://example.com/doc.pdf::',                       'https://example.com/doc.pdf::']
  ];
  for (const [input, expected] of cases) {
    const got = normaliseRef(input);
    if (got === expected) {
      console.log(`  ${c.green('✓')} "${c.dim(input.slice(0, 55))}" → stripped`);
      passed++;
    } else {
      console.log(`  ${c.red('✗')} normaliseRef failed`);
      console.log(`    Input   : ${input}`);
      console.log(`    Expected: ${expected}`);
      console.log(`    Got     : ${got}`);
      failed++;
    }
  }

  // ── Test 2: NO_RESOLVER for unknown scheme ─────────────────────────────────
  hr('Test 2: NO_RESOLVER for unknown scheme');
  // ftp:// is non-logical — routes to * catch-all webhook
  // With no RESOLVER_DEFAULT_WEBHOOK_URL set → RESOLVER_NOT_CONFIGURED (correct)
  const r_unknown = await resolverDispatch('ftp://some.server/file.txt::', 'ping');
  check('Non-logical ftp:// → catch-all → RESOLVER_NOT_CONFIGURED', r_unknown, 'RESOLVER_NOT_CONFIGURED');

  // A truly unknown LOGICAL prefix (no resolver configured) → NO_RESOLVER
  const r_logical_unknown = await resolverDispatch('widgets_0001.jsonl::', 'ping');
  check('Unknown logical prefix → NO_RESOLVER', r_logical_unknown, 'NO_RESOLVER');

  // ── Test 3: memory:// handler ──────────────────────────────────────────────
  hr('Test 3: memory:// handler');

  // 3a: ping before register → NOT_FOUND
  const memRef = 'memory://test/resolver-test-2026::';
  let r = await resolverDispatch(memRef, 'ping');
  check('ping before register → NOT_FOUND', r, 'NOT_FOUND');

  // 3b: register a record
  const testPattern = JSON.stringify([{ title: 'Resolver Test', date: '2026-06-25', tags: 'tqnn resolver test' }]);
  registerMemory(memRef, testPattern);
  console.log(`  ${c.dim('→ registered: ' + memRef)}`);

  // 3c: ping after register → AVAILABLE
  r = await resolverDispatch(memRef, 'ping');
  check('ping after register → AVAILABLE', r, 'AVAILABLE');

  // 3d: info
  r = await resolverDispatch(memRef, 'info');
  check('info → AVAILABLE with size_bytes', r, 'AVAILABLE');
  if (r.size_bytes > 0) {
    console.log(`  ${c.green('✓')} size_bytes: ${r.size_bytes}`);
    passed++;
  }

  // 3e: fetch
  r = await resolverDispatch(memRef, 'fetch');
  check('fetch → OK with content', r, 'OK');
  if (r.content === testPattern) {
    console.log(`  ${c.green('✓')} content round-trips correctly`);
    passed++;
  } else {
    console.log(`  ${c.red('✗')} content mismatch`);
    failed++;
  }

  // 3f: with DMM timestamp suffix
  const memRefWithTs = 'memory://test/resolver-test-2026::1782380000';
  r = await resolverDispatch(memRefWithTs, 'ping');
  check('ping with timestamp suffix → AVAILABLE (stripped)', r, 'AVAILABLE');

  // ── Test 4: local_jsonl handler ────────────────────────────────────────────
  hr('Test 4: local_jsonl handler');

  // Create a temp test file with records_ prefix (matches resolver scheme)
  const tmpDir  = require('os').tmpdir();
  const tmpFile = path.join(tmpDir, 'records_test.jsonl');
  const lines   = [
    JSON.stringify({ id: 'REC-00000001', patient: 'Test Patient A', diagnosis: 'Diabetes mellitus' }),
    JSON.stringify({ id: 'REC-00000002', patient: 'Test Patient B', diagnosis: 'Hypertension' }),
    JSON.stringify({ id: 'REC-00000003', patient: 'Test Patient C', diagnosis: 'Myocardial infarction' })
  ];
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n');

  // Patch the resolver config temporarily to point at tmpDir
  const origConfig = JSON.parse(fs.readFileSync('./tqnn_resolvers.json', 'utf8'));
  const patchedConfig = JSON.parse(JSON.stringify(origConfig));
  const jsonlEntry = patchedConfig.resolvers.find(r => r.handler === 'local_jsonl');
  if (jsonlEntry) jsonlEntry.config.base_path = tmpDir + path.sep;
  // Write patched config and clear module cache so resolver reloads
  fs.writeFileSync('./tqnn_resolvers.json', JSON.stringify(patchedConfig, null, 2));
  Object.keys(require.cache).filter(k => k.includes('resolver')).forEach(k => delete require.cache[k]);
  const resolverPatched = require('./resolver');

  const jsonlRef = 'records_test.jsonl::';

  r = await resolverPatched.resolverDispatch(jsonlRef, 'ping');
  check('local_jsonl ping → AVAILABLE', r, 'AVAILABLE');

  r = await resolverPatched.resolverDispatch(jsonlRef, 'info');
  check('local_jsonl info → AVAILABLE with size', r, 'AVAILABLE');
  if (r.size_bytes > 0) {
    console.log(`  ${c.green('✓')} size_bytes: ${r.size_bytes}, modified: ${r.modified}`);
    passed++;
  }

  r = await resolverPatched.resolverDispatch(jsonlRef, 'fetch');
  check('local_jsonl fetch → OK', r, 'OK');
  if (r.content && r.content.includes('Diabetes mellitus')) {
    console.log(`  ${c.green('✓')} content contains expected records`);
    passed++;
  }

  // Line extraction
  const lineRef = 'records_test.jsonl::line2::';
  r = await resolverPatched.resolverDispatch(lineRef, 'fetch');
  check('local_jsonl line2 fetch → OK', r, 'OK');
  if (r.content && r.content.includes('Hypertension')) {
    console.log(`  ${c.green('✓')} line 2 extracted correctly → ${c.dim('Hypertension')}`);
    passed++;
  }

  // Restore original config and clear cache
  fs.writeFileSync('./tqnn_resolvers.json', JSON.stringify(origConfig, null, 2));
  fs.unlinkSync(tmpFile);
  Object.keys(require.cache).filter(k => k.includes('resolver')).forEach(k => delete require.cache[k]);

  // ── Test 5: url handler ────────────────────────────────────────────────────
  hr('Test 5: url handler');

  // Reload original resolver
  delete require.cache[require.resolve('./resolver')];
  const resolverOrig = require('./resolver');

  const urlRef = 'https://httpbin.org/json::';
  r = await resolverOrig.resolverDispatch(urlRef, 'ping');
  check('url ping httpbin.org → AVAILABLE', r, 'AVAILABLE', { warn: true });

  r = await resolverOrig.resolverDispatch(urlRef, 'info');
  check('url info httpbin.org → AVAILABLE', r, 'AVAILABLE', { warn: true });
  if (r.content_type) console.log(`  ${c.dim('content-type: ' + r.content_type)}`);

  r = await resolverOrig.resolverDispatch(urlRef, 'fetch');
  check('url fetch httpbin.org → OK', r, 'OK', { warn: true });
  if (r.content) {
    console.log(`  ${c.green('✓')} content received (${r.size_bytes} bytes)`);
    passed++;
  }

  // ── Test 6: webhook / cold storage handler ─────────────────────────────────
  hr('Test 6: webhook / cold_storage handler (no webhook URL configured)');

  // Without env var set, should return RESOLVER_NOT_CONFIGURED
  delete process.env.RESOLVER_GLACIER_WEBHOOK_URL;
  const glacierRef = 'glacier://archive/2024/Q1/batch-003::';
  r = await resolverOrig.resolverDispatch(glacierRef, 'ping');
  // ping on cold_storage without URL → COLD_STORAGE (URL check skipped for ping/info)
  check('glacier ping → COLD_STORAGE', r, 'COLD_STORAGE');

  r = await resolverOrig.resolverDispatch(glacierRef, 'info');
  check('glacier info → RETRIEVAL_PENDING', r, 'RETRIEVAL_PENDING');

  r = await resolverOrig.resolverDispatch(glacierRef, 'fetch');
  // fetch without webhook URL → RESOLVER_NOT_CONFIGURED
  check('glacier fetch without URL → RESOLVER_NOT_CONFIGURED', r, 'RESOLVER_NOT_CONFIGURED');

  // ── Test 7: NOT_FOUND paths ────────────────────────────────────────────────
  hr('Test 7: NOT_FOUND and edge cases');

  // Memory ref that was never stored
  r = await resolverOrig.resolverDispatch('memory://nonexistent/record::', 'fetch');
  check('memory fetch non-existent → NOT_FOUND', r, 'NOT_FOUND');

  // Local file that does not exist
  r = await resolverOrig.resolverDispatch('records_9999_missing.jsonl::', 'ping');
  check('local_jsonl ping missing file → NOT_FOUND', r, 'NOT_FOUND');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + c.bold('═'.repeat(65)));
  console.log(c.bold('  Results'));
  console.log('═'.repeat(65));
  console.log(`  ${c.green('✓ Passed')} : ${passed}`);
  if (warned > 0) console.log(`  ${c.yellow('⚠ Warned')} : ${warned}  (network-dependent — expected in offline env)`);
  if (failed > 0) console.log(`  ${c.red('✗ Failed')} : ${failed}`);
  console.log('═'.repeat(65) + '\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(c.red('\n✗ Unhandled error:'), err);
  process.exit(1);
});
