'use strict';

/**
 * Quick integration test for all site plugins
 * Run: node test/test-all.js
 *
 * Tests use real URLs — internet connection required.
 * Replace TEST_URLS with fresh URLs before running.
 */

const { bypass } = require('../src/orchestrator');
const registry   = require('../src/registry');

// ── Replace these with fresh URLs when testing ────────────────────────────
const TEST_URLS = {
  hubcloud  : 'https://hubcloud.pw/drive/hjbxwnwshhhqyu8',
  hubdrive  : 'https://hubdrive.blog/file/3002211248',
  multicloud: 'https://new3.multicloudlinks.com/view/f533404ca2?c=72hb9w&exp=1795012311&token=0a724cea14ed2209',
  drivehub  : 'https://new2.drivehub.dad/file/4346143',
  gofile    : 'https://gofile.io/d/pVawQzDG',
};

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red  : '\x1b[31m',
  yellow:'\x1b[33m',
  cyan : '\x1b[36m',
  bold : '\x1b[1m',
};

function log(msg, color = 'reset') {
  console.log(`${COLORS[color]}${msg}${COLORS.reset}`);
}

async function testSite(name, url) {
  const start = Date.now();
  log(`\n── Testing ${name} ──────────────────────────────`, 'cyan');
  log(`URL: ${url}`);

  try {
    const result = await bypass(url, { skipCache: true });
    const ms     = Date.now() - start;

    log(`✓ SUCCESS in ${ms}ms`, 'green');
    log(`  Site     : ${result.site}`);
    log(`  File ID  : ${result.file_id}`);
    log(`  Filename : ${result.metadata?.filename || '—'}`);
    log(`  Size     : ${result.metadata?.size || '—'}`);
    log(`  Servers  : ${result.servers.length}`);

    result.servers.forEach((s, i) => {
      log(`  ${i+1}. [${s.server}] ${s.label}`);
      log(`     ${s.url.slice(0, 80)}...`);
    });

    return { name, success: true, ms, servers: result.servers.length };
  } catch (err) {
    const ms = Date.now() - start;
    log(`✗ FAILED in ${ms}ms: ${err.message}`, 'red');
    return { name, success: false, ms, error: err.message };
  }
}

async function testRegistry() {
  log('\n── Registry test ────────────────────────────────', 'cyan');
  const sites = registry.list();
  log(`Loaded plugins: ${sites.length}`);
  sites.forEach(s => log(`  • ${s.id} (${s.name}) — ${s.domains.join(', ')}`));

  // Test URL matching
  const matchTests = [
    ['https://hubcloud.pw/drive/ABC',                              'hubcloud'],
    ['https://gofile.io/d/ABC',                                    'gofile'],
    ['https://hubdrive.blog/file/123',                             'hubdrive'],
    ['https://new3.multicloudlinks.com/view/abc',                  'multicloud'],
    ['https://new2.drivehub.dad/file/123',                         'drivehub'],
    ['https://unknown-site.com/file/123',                          null],
  ];

  let passed = 0;
  for (const [url, expected] of matchTests) {
    const plugin = registry.match(url);
    const got    = plugin?.id || null;
    const ok     = got === expected;
    if (ok) passed++;
    log(`  ${ok ? '✓' : '✗'} ${new URL(url).hostname} → ${got || 'null'} (expected: ${expected || 'null'})`, ok ? 'green' : 'red');
  }
  log(`Match tests: ${passed}/${matchTests.length} passed`, passed === matchTests.length ? 'green' : 'yellow');
}

async function main() {
  log('\n╔══════════════════════════════════════════════╗', 'bold');
  log('║   MultiSite Bypass API — Integration Tests   ║', 'bold');
  log('╚══════════════════════════════════════════════╝\n', 'bold');

  // Test registry first
  await testRegistry();

  // Test each site
  const results = [];
  for (const [name, url] of Object.entries(TEST_URLS)) {
    const r = await testSite(name, url);
    results.push(r);
    // Small delay between tests
    await new Promise(res => setTimeout(res, 500));
  }

  // Summary
  log('\n── Summary ──────────────────────────────────────', 'bold');
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  results.forEach(r => {
    const icon = r.success ? '✓' : '✗';
    const col  = r.success ? 'green' : 'red';
    const info = r.success ? `${r.servers} servers, ${r.ms}ms` : r.error;
    log(`${icon} ${r.name.padEnd(12)} ${info}`, col);
  });

  log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`, passed === results.length ? 'green' : 'yellow');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
