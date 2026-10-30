// Tests for the engagement guards. These are the rules that stop a well-meaning
// person from producing a dishonest before/after, so they are worth more test
// coverage than anything else in the repo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  initProject,
  loadProject,
  recordSnapshot,
  recordChange,
  assertComparable,
  buildComparison,
  formatComparison,
} from '../src/project.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speedkit-test-'));
const dir = path.join(tmp, 'acme');

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

const HOME = 'https://acme.test/';
const PROD = 'https://acme.test/products/x';

const snap = (phase, { runs = 5, strategy = 'mobile', score = 40, lcp = 8000, tbt = 600, cloak = false } = {}) => ({
  capturedAt: `2026-07-29T10:0${phase === 'before' ? 0 : 5}:00.000Z`,
  strategy,
  runs,
  dir: `/tmp/${phase}`,
  cloakSuspected: cloak,
  pages: {
    [HOME]: { score, scoreRuns: [score - 2, score, score + 2], metrics: { lcp, tbt, fcp: 3000, cls: 0.001 } },
    [PROD]: { score: score + 5, scoreRuns: [score + 3, score + 5, score + 7], metrics: { lcp: lcp - 100, tbt: tbt - 200, fcp: 2700, cls: 0.001 } },
  },
});

console.log('\n--- engagement guards ---');

const project = initProject(dir, { shop: 'example.myshopify.com', storefront: 'https://acme.test', urls: [HOME, PROD] });

check('init creates the folder skeleton', () => {
  for (const sub of ['01-before', '02-optimization/backups', '03-after']) {
    assert.ok(fs.existsSync(path.join(dir, sub)), `missing ${sub}`);
  }
  assert.equal(project.phase, 'initialized');
});

check('init refuses to clobber an existing project', () => {
  assert.throws(() => initProject(dir, { shop: 'example.myshopify.com', storefront: 'x', urls: [HOME] }), /already exists/);
});

check('measurement method is frozen at init', () => {
  assert.equal(project.measurement.runs, 5); // Google: median of 5
  assert.equal(project.measurement.strategy, 'mobile');
  assert.deepEqual(project.measurement.urls, [HOME, PROD]);
});

recordSnapshot(dir, project, 'before', snap('before'));

check('BEFORE is write-once (no shopping for a nicer baseline)', () => {
  assert.throws(() => recordSnapshot(dir, project, 'before', snap('before', { score: 70 })), /immutable/i);
});

check('comparison refused before AFTER exists', () => {
  assert.throws(() => assertComparable(project), /No AFTER snapshot/);
});

check('comparison refused when run counts differ', () => {
  const p = { ...project, after: snap('after', { runs: 1 }) };
  assert.throws(() => assertComparable(p), /run count differs/);
});

check('comparison refused when strategy differs', () => {
  const p = { ...project, after: snap('after', { strategy: 'desktop' }) };
  assert.throws(() => assertComparable(p), /strategy differs/);
});

check('comparison refused when page sets differ', () => {
  const after = snap('after');
  delete after.pages[PROD];
  assert.throws(() => assertComparable({ ...project, after }), /page sets differ/);
});

recordChange(dir, project, { summary: 'de-duplicated recip bundle', backup: '/tmp/backup1' });
check('first change moves the project into optimizing', () => {
  assert.equal(loadProject(dir).phase, 'optimizing');
});

recordSnapshot(dir, project, 'after', snap('after', { score: 72, lcp: 2400, tbt: 150 }));
const cmp = buildComparison(project);

check('deltas computed from medians', () => {
  const home = cmp.pages.find((p) => p.url === HOME);
  assert.equal(home.score.before, 40);
  assert.equal(home.score.after, 72);
  assert.equal(home.score.delta, 32);
  assert.equal(home.lcpMs.delta, -5600);
});

check('applied changes ride along with the comparison', () => {
  assert.equal(cmp.changes.length, 1);
  assert.match(cmp.changes[0].summary, /recip/);
});

check('clean baseline emits no cloak disclosure', () => {
  assert.equal(cmp.disclosures.filter((d) => /cloak/i.test(d)).length, 0);
});

// The Luna case: baseline measured while cloaked.
const cloaked = initProject(path.join(tmp, 'cloaked'), {
  shop: 'example.myshopify.com',
  storefront: 'https://cloak.test',
  urls: [HOME, PROD],
});
recordSnapshot(path.join(tmp, 'cloaked'), cloaked, 'before', snap('before', { score: 97, cloak: true }));
recordSnapshot(path.join(tmp, 'cloaked'), cloaked, 'after', snap('after', { score: 92 }));
const cloakCmp = buildComparison(cloaked);

check('cloaked baseline forces a disclosure', () => {
  const d = cloakCmp.disclosures.find((x) => /cloak/i.test(x));
  assert.ok(d, 'no cloak disclosure emitted');
  assert.match(d, /never received/);
  assert.match(d, /not a valid baseline|NOT a valid baseline/);
});

check('cloak disclosure explains a LOWER after is not a regression', () => {
  const d = cloakCmp.disclosures.find((x) => /cloak/i.test(x));
  assert.match(d, /became honest, not that/);
});

check('single-run baseline is disclosed as noise-prone', () => {
  const p = initProject(path.join(tmp, 'oneRun'), { shop: 'example.myshopify.com', storefront: 'x', urls: [HOME, PROD], runs: 1 });
  recordSnapshot(path.join(tmp, 'oneRun'), p, 'before', snap('before', { runs: 1 }));
  recordSnapshot(path.join(tmp, 'oneRun'), p, 'after', snap('after', { runs: 1 }));
  const c = buildComparison(p);
  assert.ok(c.disclosures.some((d) => /swing/i.test(d)), 'no run-count disclosure');
});

check('rendered report shows both runs and disclosures', () => {
  const out = formatComparison(cloakCmp, cloaked);
  assert.match(out, /median of 5 runs/);
  assert.match(out, /DISCLOSURES/);
  assert.match(out, /runs 95\/97\/99/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
