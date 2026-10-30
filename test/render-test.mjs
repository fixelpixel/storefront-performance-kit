// Renderer + validator test for the AI layer.
//
// The model call itself needs network + a key, so it is NOT exercised here.
// What IS exercised is everything around it: that a well-formed diagnosis
// renders every section, and that an untrustworthy baseline is shouted rather
// than buried. The diagnosis below is a FIXTURE, not model output.

import assert from 'node:assert/strict';
import { formatDiagnosis } from '../src/ai.mjs';

const evidence = {
  url: 'https://example-store.test/',
  strategy: 'mobile',
  score: 45,
  scoreRuns: [41, 45, 49],
  metrics: {
    lcp: { value: 8900, display: '8.9 s' },
    tbt: { value: 610, display: '610 ms' },
    fcp: { value: 3200, display: '3.2 s' },
    cls: { value: 0.001, display: '0.001' },
    speedIndex: { value: 9700, display: '9.7 s' },
  },
};

const fixture = {
  verdict: 'LCP is late, not heavy: images are already optimal, so the paint waits on a saturated main thread.',
  baselineTrustworthy: false,
  baselineWarning: 'A test-gated script was found; the measured score describes a page shoppers never receive.',
  ruledOut: [
    { cause: 'Image weight', evidence: 'image-optimization savings = 0 bytes' },
    { cause: 'Third-party apps', evidence: 'third-party-summary shows negligible blocking time' },
  ],
  rootCauses: [
    { rank: 1, cause: 'Same bundle loaded 3x', evidence: 'recip.js x3, ~100% unused', confidence: 'confirmed', affects: ['TBT', 'LCP'] },
    { rank: 2, cause: 'Style & layout work 3085ms', evidence: 'mainthread-work-breakdown', confidence: 'high', affects: ['LCP'] },
  ],
  fixes: [
    { rank: 1, title: 'De-duplicate the bundle', what: 'Load it once', where: 'app setting', mechanism: 'removes parse+execute from the main thread', effort: 'S', risk: 'low', reversible: true, requiresQA: ['none'] },
    { rank: 2, title: 'Defer analytics', what: 'Load GTM on interaction', where: 'theme file', mechanism: 'frees main thread before LCP', effort: 'M', risk: 'medium', reversible: true, requiresQA: ['tracking'] },
  ],
  doNotDo: ['Do not add a hero preload — the LCP resource is not the bottleneck.'],
  openQuestions: ['Is the duplicate injected by the app or hard-coded in the theme?'],
  clientSummary: 'Your pages wait on scripts, not pictures. The first fix is removing a file that loads three times.',
  _meta: { model: 'fixture/not-a-real-model', usage: null },
};

const out = formatDiagnosis(fixture, evidence);
console.log(out);

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

console.log('\n--- assertions ---');
check('untrustworthy baseline is shouted', () => assert.match(out, /BASELINE NOT TRUSTWORTHY/));
check('baseline warning shown', () => assert.match(out, /shoppers never receive/));
check('median runs disclosed', () => assert.match(out, /runs: 41, 45, 49 — median/));
check('ruled-out section present', () => assert.match(out, /RULED OUT/));
check('image weight explicitly ruled out', () => assert.match(out, /Image weight/));
check('root causes ranked with confidence', () => assert.match(out, /1\. \[●●● confirmed\]/));
check('fixes show effort/risk', () => assert.match(out, /effort S · risk low/));
check('QA warning surfaced for tracking', () => assert.match(out, /⚠ QA:\s+tracking/));
check('do-not list present', () => assert.match(out, /DO NOT/));
check('client summary present', () => assert.match(out, /FOR THE CLIENT/));
check('no fabricated score promise', () => assert.doesNotMatch(out, /will (?:reach|hit|improve to) \d+/i));

console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
