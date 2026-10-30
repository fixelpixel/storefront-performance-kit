// Knowledge-base tests. The KB feeds the diagnosis prompt, so garbage here
// propagates into every future client report — validation is not optional.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speedkit-kb-'));
process.env.SPEEDKIT_KB = tmp;

const { saveFinding, recordSighting, loadFindings, findingsForPrompt, caseFromProject, saveCase, loadCases, searchFindings } =
  await import('../src/kb.mjs');

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

const base = {
  title: 'T',
  summary: 'S',
  category: 'anti-pattern',
  confidence: 'confirmed',
  affects: ['TBT'],
};

console.log('\n--- knowledge base ---');

check('rejects an unknown category', () => {
  assert.throws(() => saveFinding({ ...base, id: 'x', category: 'nonsense' }), /category must be one of/);
});

check('rejects an unknown confidence label', () => {
  assert.throws(() => saveFinding({ ...base, id: 'x', confidence: 'certain-ish' }), /confidence must be one of/);
});

check('requires an id', () => {
  assert.throws(() => saveFinding({ ...base }), /id is required/);
});

saveFinding({ ...base, id: 'alpha', seenAt: [{ client: 'c1', at: '2026-01-01' }] });
saveFinding({ ...base, id: 'beta', confidence: 'probable' });

check('findings persist as individual files', () => {
  assert.equal(loadFindings().length, 2);
  assert.ok(fs.existsSync(path.join(tmp, 'findings', 'alpha.json')));
});

check('sightings accumulate rather than overwrite', () => {
  recordSighting('alpha', { client: 'c2', note: 'again' });
  const f = loadFindings().find((x) => x.id === 'alpha');
  assert.equal(f.seenAt.length, 2);
  assert.deepEqual(
    f.seenAt.map((s) => s.client),
    ['c1', 'c2']
  );
});

check('recording a sighting on an unknown finding fails loudly', () => {
  assert.throws(() => recordSighting('ghost', { client: 'c' }), /No finding/);
});

check('prompt view ranks what WE have seen above unseen advice', () => {
  const rows = findingsForPrompt();
  assert.equal(rows[0].id, 'alpha');
  assert.equal(rows[0].timesSeenByUs, 2);
  assert.equal(rows[1].timesSeenByUs, 0);
});

check('prompt view exposes confidence so priors can be weighed', () => {
  const rows = findingsForPrompt();
  assert.equal(rows.find((r) => r.id === 'beta').confidence, 'probable');
});

check('search matches across summary and detection text', () => {
  saveFinding({ ...base, id: 'gamma', detection: 'look for a triple-loaded bundle' });
  assert.equal(searchFindings('triple-loaded').length, 1);
  assert.equal(searchFindings('nothing-matches-this').length, 0);
});

check('malformed KB file is skipped, not fatal', () => {
  fs.writeFileSync(path.join(tmp, 'findings', 'broken.json'), '{not json');
  assert.equal(loadFindings().length, 3);
});

const project = {
  shop: 'example.myshopify.com',
  storefront: 'https://acme.test',
  measurement: { urls: ['https://acme.test/'], strategy: 'mobile', runs: 3 },
  before: {
    capturedAt: '2026-07-20T10:00:00.000Z',
    cloakSuspected: true,
    pages: { 'https://acme.test/': { score: 40, metrics: { lcp: 8000, tbt: 600 } } },
  },
  after: {
    capturedAt: '2026-07-25T10:00:00.000Z',
    pages: { 'https://acme.test/': { score: 80, metrics: { lcp: 2000, tbt: 100 } } },
  },
  changes: [{ summary: 'removed cloak' }],
};

check('a finished project becomes a case with real deltas', () => {
  const c = caseFromProject(project, { whatWorked: ['dedupe'] });
  assert.equal(c.id, 'example-2026-07-20');
  assert.equal(c.pages[0].score.before, 40);
  assert.equal(c.pages[0].score.after, 80);
  assert.equal(c.baselineCloaked, true, 'a cloaked baseline must be carried into the case');
  assert.deepEqual(c.whatWorked, ['dedupe']);
});

check('cases persist', () => {
  saveCase(caseFromProject(project));
  assert.equal(loadCases().length, 1);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
