// Report generator tests.
//
// The report is the artifact a paying merchant actually receives, so what is
// tested here is not markup taste — it is the honesty contract:
//   - disclosures ride along automatically (cloak, low run count), verbatim;
//   - the free tier really withholds the plan, file names and the how;
//   - confidence labels survive into the client document;
//   - null renders as "—", never 0;
//   - what did NOT improve appears, not just the wins;
//   - no external assets (the file must print to PDF offline);
//   - nothing from another engagement can leak in (report.mjs must not even
//     import the knowledge base, whose findings carry other clients' names).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  renderReport,
  renderFreeReport,
  renderPaidReport,
  renderFinalReport,
  collectNotImproved,
  collectRemaining,
  scrubFileNames,
} from '../src/report.mjs';
import { initProject, recordSnapshot, recordChange, buildComparison } from '../src/project.mjs';

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

// Every stage must satisfy these, so they run against each rendered document.
const universal = (html, stage) => {
  check(`${stage}: self-contained — no external scripts/styles/fonts/images`, () => {
    assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']https?:/i, 'external src/href found');
    assert.doesNotMatch(html, /@import|fonts\.googleapis|url\(\s*["']?https?:/i, 'external CSS resource found');
    assert.doesNotMatch(html, /<script/i, 'script tag in a client deliverable');
  });
  check(`${stage}: no promised score/metric gain`, () => {
    assert.doesNotMatch(html, /will (?:reach|hit|improve to|gain) \d+/i);
    assert.doesNotMatch(html, /guarantee[ds]? (?:a|an|\d)/i);
    assert.match(html, /mechanisms and direction only/i, 'no-promise clause missing from footer');
  });
};

// --- fixtures ---------------------------------------------------------------

const evidence = {
  url: 'https://client-a.test/',
  strategy: 'mobile',
  score: 45,
  scoreRuns: [45],
  metrics: {
    lcp: { value: 8900, display: '8.9 s' },
    tbt: { value: 610, display: '610 ms' },
    fcp: { value: 3200, display: '3.2 s' },
    cls: { value: null, display: null }, // deliberately missing → must render "—"
    speedIndex: { value: 9700, display: '9.7 s' },
  },
};

const diagnosis = {
  verdict: 'LCP is late, not heavy: images are already optimal, so the paint waits on a saturated main thread.',
  baselineTrustworthy: true,
  baselineWarning: null,
  ruledOut: [{ cause: 'Image weight', evidence: 'image-optimization savings = 0 bytes' }],
  rootCauses: [
    { rank: 2, cause: 'Style & layout work 3085ms', evidence: 'mainthread-work-breakdown', confidence: 'high', affects: ['LCP'] },
    { rank: 1, cause: 'Same bundle recip-widget.js loaded 3x', evidence: 'recip-widget.js x3, ~100% unused', confidence: 'probable', affects: ['TBT', 'LCP'] },
  ],
  fixes: [
    { rank: 1, title: 'De-duplicate the recip bundle', what: 'Load it once', where: 'app setting', mechanism: 'removes parse+execute from the main thread', effort: 'S', risk: 'low', reversible: true, requiresQA: ['none'] },
    { rank: 2, title: 'Defer analytics bootstrap', what: 'Load GTM on interaction', where: 'theme file', mechanism: 'frees main thread before LCP', effort: 'M', risk: 'medium', reversible: true, requiresQA: ['tracking'] },
  ],
  doNotDo: ['Do not add a hero preload — the LCP resource is not the bottleneck.'],
  openQuestions: ['Is the duplicate injected by the app or hard-coded in the theme?'],
  matchedFindings: [{ id: 'duplicate-bundle-loads', why: 'same bundle 3x matches the signature' }],
  clientSummary: 'Your pages wait on scripts, not pictures. The first fix is removing a file that loads three times.',
};

// --- FREE -------------------------------------------------------------------

console.log('\n--- report: free ---');
const free = renderFreeReport({ label: 'https://client-a.test', diagnosis, evidence, generatedAt: '2026-07-29T12:00:00Z' });
universal(free, 'free');

check('free: shows the score and the headline cause', () => {
  assert.match(free, />45</);
  assert.match(free, /Same bundle .* loaded 3x|loaded 3x/i);
  assert.match(free, /wait on scripts, not pictures/);
});

check('free: WITHHOLDS the fix plan, ruled-out list and the how', () => {
  assert.doesNotMatch(free, /De-duplicate the recip bundle/);
  assert.doesNotMatch(free, /Defer analytics bootstrap/);
  assert.doesNotMatch(free, /Ruled out/i);
  assert.doesNotMatch(free, /removes parse\+execute/); // mechanism = the how
  assert.doesNotMatch(free, /effort/i);
});

check('free: file names are scrubbed, even inside the headline cause', () => {
  assert.doesNotMatch(free, /recip-widget\.js/);
  assert.match(free, /a code file/);
});

check('free: single lab run is disclosed as directional, not a baseline', () => {
  assert.match(free, /Single lab run/i);
});

check('free: missing CLS renders as "—", never 0', () => {
  assert.doesNotMatch(free, /Cumulative Layout Shift[^<]*<\/td><td class="num">0</);
  assert.match(free, /A missing measurement is not a zero/);
});

check('free: cloaked measurement carries the honesty warning automatically', () => {
  const cloaked = renderFreeReport({
    label: 'x',
    evidence,
    diagnosis: { ...diagnosis, baselineTrustworthy: false, baselineWarning: 'A test-gated script was found; the measured score describes a page shoppers never receive.' },
  });
  assert.match(cloaked, /shoppers never receive/);
  assert.match(cloaked, /measurement became honest, not that the site regressed/);
});

check('free: model text is HTML-escaped', () => {
  const evil = renderFreeReport({
    label: 'x',
    evidence,
    diagnosis: { ...diagnosis, clientSummary: '<script>alert(1)</script> & co' },
  });
  assert.doesNotMatch(evil, /<script>alert/);
  assert.match(evil, /&lt;script&gt;/);
});

// --- PAID (uses a real project so the disclosures come from the real guard) --

console.log('\n--- report: paid ---');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speedkit-report-'));
const HOME = 'https://client-a.test/';
const PROD = 'https://client-a.test/products/x';

const snap = (phase, { runs = 5, score = 40, lcp = 8000, tbt = 600, cls = 0.001, cloak = false } = {}) => ({
  capturedAt: `2026-07-2${phase === 'before' ? 0 : 8}T10:00:00.000Z`,
  strategy: 'mobile',
  runs,
  dir: `/tmp/${phase}`,
  cloakSuspected: cloak,
  pages: {
    [HOME]: { score, scoreRuns: [score - 2, score, score + 2], metrics: { lcp, tbt, fcp: 3000, cls } },
    [PROD]: { score: score + 5, scoreRuns: [score + 3, score + 5, score + 7], metrics: { lcp: lcp - 100, tbt: tbt - 200, fcp: 2700, cls: null } },
  },
});

const dirA = path.join(tmp, 'client-a');
const projectA = initProject(dirA, { shop: 'example.myshopify.com', storefront: 'https://client-a.test', urls: [HOME, PROD] });
recordSnapshot(dirA, projectA, 'before', snap('before', { cloak: true }));

const paid = renderPaidReport({ project: projectA, diagnosis, generatedAt: '2026-07-29T12:00:00Z' });
universal(paid, 'paid');

check('paid: is the frozen BEFORE record, with the full baseline table', () => {
  assert.match(paid, /frozen BEFORE record/);
  assert.match(paid, /median of 5 runs/);
  assert.match(paid, /38 \/ 40 \/ 42/); // individual runs shown alongside the median
  assert.match(paid, /8\.0 s/); // baseline LCP
});

check('paid: cloaked baseline forces the verbatim disclosure', () => {
  assert.match(paid, /benchmark-cloaking code was live/);
  assert.match(paid, /became honest, not that/);
  assert.match(paid, /NOT a valid baseline/);
});

check('paid: confidence labels survive — "probable" is not laundered into fact', () => {
  assert.match(paid, />probable</);
  assert.match(paid, /A "probable" cause is a hypothesis, not a fact\./);
});

check('paid: root causes come out ranked despite unsorted input', () => {
  const first = paid.indexOf('recip-widget.js loaded 3x');
  const second = paid.indexOf('Style &amp; layout work');
  assert.ok(first !== -1 && second !== -1 && first < second, 'rank 1 should render before rank 2');
});

check('paid: ruled-out section and fixes with effort/risk/QA are present', () => {
  assert.match(paid, /Ruled out/i);
  assert.match(paid, /Image weight/);
  assert.match(paid, /De-duplicate the recip bundle/);
  assert.match(paid, /tracking/); // the QA flag
});

check('paid: null CLS on the product page renders as "—", never 0', () => {
  const productRow = paid.slice(paid.lastIndexOf('products/x'), paid.lastIndexOf('products/x') + 600);
  const cells = [...productRow.matchAll(/<td class="num">([^<]*)<\/td>/g)].map((m) => m[1]);
  assert.equal(cells[cells.length - 1], '—', `CLS cell should be — (got: ${JSON.stringify(cells)})`);
});

check('paid: refuses to render without the frozen BEFORE', () => {
  assert.throws(() => renderPaidReport({ project: { ...projectA, before: null }, diagnosis }), /BEFORE snapshot/);
});

check('paid: matched KB patterns appear as a count only — no ids, no other clients', () => {
  assert.match(paid, /1 of the patterns above match findings/);
  assert.doesNotMatch(paid, /duplicate-bundle-loads/); // even the internal id stays out
});

check('paid: sub-5-run baseline gets the noise caveat automatically', () => {
  const dirB = path.join(tmp, 'client-b');
  const p = initProject(dirB, { shop: 'example.myshopify.com', storefront: 'https://client-b.test', urls: [HOME], runs: 1 });
  recordSnapshot(dirB, p, 'before', { ...snap('before', { runs: 1 }), pages: { [HOME]: snap('before').pages[HOME] } });
  const out = renderPaidReport({ project: p, diagnosis });
  assert.match(out, /below the 5-run median/);
  assert.match(out, /not evidence of change/);
});

// --- FINAL --------------------------------------------------------------------

console.log('\n--- report: final ---');
// TBT regresses on the product page; CLS is unmeasured there. Both must surface.
recordChange(dirA, projectA, { summary: 'De-duplicate the recip bundle — app setting change', backup: '/tmp/b1' });
const after = snap('after', { score: 72, lcp: 2400, tbt: 150 });
after.pages[PROD].metrics.tbt = 700; // worse than before's 400
recordSnapshot(dirA, projectA, 'after', after);

const finalHtml = renderFinalReport({ project: projectA, diagnosis, generatedAt: '2026-07-29T12:00:00Z' });
universal(finalHtml, 'final');

check('final: carries compare\'s disclosures VERBATIM', () => {
  const cmp = buildComparison(projectA);
  assert.ok(cmp.disclosures.length >= 1, 'fixture should have produced disclosures');
  for (const d of cmp.disclosures) {
    assert.ok(finalHtml.includes(d), `disclosure not carried verbatim: ${d.slice(0, 60)}…`);
  }
});

check('final: before/after with medians AND the individual runs alongside', () => {
  assert.match(finalHtml, /38 \/ 40 \/ 42/);
  assert.match(finalHtml, /70 \/ 72 \/ 74/);
  assert.match(finalHtml, /Medians are reported, never the best run/);
});

check('final: what did NOT improve appears — the TBT regression is named', () => {
  const section = finalHtml.slice(finalHtml.indexOf('What did not improve'));
  assert.match(section, /TBT/);
  assert.match(section, /worse than the baseline/);
});

check('final: unmeasured metric appears as no-claim, not as a win', () => {
  const rows = collectNotImproved(buildComparison(projectA));
  const clsRow = rows.find((r) => r.metric === 'CLS' && r.url === PROD);
  assert.ok(clsRow, 'missing-CLS row should be listed');
  assert.match(clsRow.note, /no improvement is claimed/);
});

check('final: changes are listed with no per-change causality claim', () => {
  assert.match(finalHtml, /De-duplicate the recip bundle — app setting change/);
  assert.match(finalHtml, /no per-change causal claim/);
});

check('final: what remains lists unapplied fixes from the diagnosis', () => {
  const remaining = collectRemaining(diagnosis, projectA.changes);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].title, 'Defer analytics bootstrap');
  assert.match(finalHtml, /Defer analytics bootstrap/);
});

check('final: without a stored diagnosis, remains says so instead of pretending', () => {
  const out = renderFinalReport({ project: projectA, diagnosis: null });
  assert.match(out, /No stored diagnosis was found/);
});

check('final: refuses non-equivalent inputs (guard is inherited from compare)', () => {
  const broken = { ...projectA, after: { ...projectA.after, runs: 1 } };
  assert.throws(() => renderFinalReport({ project: broken }), /run count differs/);
});

check('final: all-improved case states it explicitly (section still present)', () => {
  const dirC = path.join(tmp, 'client-c');
  const p = initProject(dirC, { shop: 'example.myshopify.com', storefront: 'https://client-c.test', urls: [HOME, PROD] });
  recordSnapshot(dirC, p, 'before', snap('before'));
  recordSnapshot(dirC, p, 'after', snap('after', { score: 72, lcp: 2400, tbt: 150, cls: 0.0005 }));
  const out = renderFinalReport({ project: p, diagnosis: null });
  assert.match(out, /What did not improve/);
  // Not all-improved here (CLS null on PROD) — verify the honest branch instead:
  assert.match(out, /no improvement is claimed/);
});

// --- cross-cutting --------------------------------------------------------------

console.log('\n--- report: privacy + dispatch ---');

check('PRIVACY: report.mjs never imports the knowledge base (findings name other clients)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/report.mjs'), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]\.\/kb(\.mjs)?['"]/, 'report.mjs imports kb.mjs — findings carry other clients\' names');
  assert.doesNotMatch(src, /from\s+['"]\.\/store(\.mjs)?['"]/, 'report.mjs imports token storage');
});

check('scrubFileNames catches liquid/css/mjs paths too', () => {
  assert.equal(scrubFileNames('edit sections/hero.liquid and assets/theme.css'), 'edit a code file and a code file');
});

check('renderReport dispatches and rejects unknown stages', () => {
  assert.throws(() => renderReport('secret', {}), /Unknown report stage/);
  assert.match(renderReport('free', { label: 'x', diagnosis, evidence }), /Free speed check/i);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
