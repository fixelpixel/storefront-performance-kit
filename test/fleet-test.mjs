// Fleet aggregation tests.
//
// The privacy assertion is the important one. The aggregate is the artifact we
// commit and may quote to prospects; if a client's storefront URL leaks into it,
// we would be handing one client's problems to another.

import assert from 'node:assert/strict';
import { aggregate, formatFleet } from '../src/fleet.mjs';

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};

const store = (over = {}) => ({
  input: 'example.myshopify.com',
  ok: true,
  url: 'https://secret-client-brand.com/',
  cloakSuspected: false,
  duplicates: [],
  duplicateCount: 0,
  maxDuplicateLoads: 0,
  scripts: { external: 20, inline: 5, renderBlocking: 4, blockingUrls: [], scanned: 20 },
  earlyImages: { count: 3, lazy: 0, firstIsLazy: false, anyFetchPriority: false },
  thirdPartyHosts: ['cdn.vendor-a.com'],
  optimizerHints: [],
  opaqueScripts: 0,
  findingSources: [],
  ...over,
});

const results = [
  store({ cloakSuspected: true, optimizerHints: ['hyperspeed'], opaqueScripts: 2 }),
  store({ duplicateCount: 2, maxDuplicateLoads: 3, thirdPartyHosts: ['cdn.vendor-a.com', 'cdn.vendor-b.com'] }),
  store({ earlyImages: { count: 4, lazy: 2, firstIsLazy: true, anyFetchPriority: false } }),
  store({ earlyImages: { count: 2, lazy: 0, firstIsLazy: false, anyFetchPriority: true } }),
  { input: 'example.myshopify.com', ok: false, error: 'ENOTFOUND' },
];
// A raw result from a scan that predates the opaqueScripts field:
delete results[3].opaqueScripts;

const summary = aggregate(results);

console.log('\n--- fleet aggregation ---');

check('failed stores are excluded from the denominator, not silently dropped', () => {
  assert.equal(summary.storesAttempted, 5);
  assert.equal(summary.storesScanned, 4);
  assert.equal(summary.storesFailed, 1);
});

check('cloak prevalence computed over scanned stores', () => {
  assert.equal(summary.prevalence.cloakSuspected.count, 1);
  assert.equal(summary.prevalence.cloakSuspected.pct, 25);
});

check('triple-load counted separately from any-duplicate', () => {
  assert.equal(summary.prevalence.duplicateBundles.count, 1);
  assert.equal(summary.prevalence.tripleLoadedBundle.count, 1);
});

check('lazy-first-image uses an images-found denominator, not all stores', () => {
  assert.equal(summary.prevalence.firstImageLazy.count, 1);
  assert.equal(summary.prevalence.firstImageLazy.denominator, 4);
});

check('third-party hosts ranked by store count', () => {
  assert.equal(summary.topThirdPartyHosts[0].host, 'cdn.vendor-a.com');
  assert.equal(summary.topThirdPartyHosts[0].stores, 4);
});

check('third-party optimizer installs surfaced', () => {
  assert.equal(summary.optimizerHints[0].label, 'hyperspeed');
  assert.equal(summary.prevalence.thirdPartyOptimizerInstalled.count, 1);
});

check('OPAQUE prevalence aggregated, separately from the cloak verdict', () => {
  assert.equal(summary.prevalence.opaqueScripts.count, 1);
  assert.equal(summary.prevalence.opaqueScripts.pct, 25);
  assert.match(formatFleet(summary), /OPAQUE \(unreadable\) scripts/);
  assert.match(formatFleet(summary), /opaque ≠ cloak/);
});

check('raw results predating the opaqueScripts field still aggregate', () => {
  assert.equal(results[3].opaqueScripts, undefined); // the fixture really is field-less
  // and aggregate() above did not throw — count treats missing as 0, not as data
});

check('sampling bias is stated in the artifact itself, not left to the reader', () => {
  assert.match(summary.population, /NOT a random sample/i);
  assert.match(summary.population, /should\s+not be presented as a Shopify-wide rate/i);
});

// The one that matters most.
check('PRIVACY: no client identifier survives into the committable aggregate', () => {
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes('secret-client'), 'shop domain leaked into aggregate');
  assert.ok(!serialized.includes('secret-client-brand.com'), 'storefront URL leaked into aggregate');
  assert.ok(!serialized.includes('dead-store'), 'failed store identifier leaked into aggregate');
});

check('rendered report also leaks no identifiers', () => {
  const out = formatFleet(summary);
  assert.ok(!out.includes('secret-client'), 'identifier leaked into rendered fleet report');
  assert.match(out, /NOT a random sample/i);
});

check('empty input does not divide by zero', () => {
  const empty = aggregate([]);
  assert.equal(empty.storesScanned, 0);
  assert.equal(empty.prevalence.cloakSuspected.pct, 0);
});

console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
