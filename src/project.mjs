// Engagement state — the thing that makes a project survivable.
//
// A speed engagement runs over days, across sessions, and (for us) across
// agents with no memory of each other. So the project lives ON DISK, not in
// anyone's head: page set, phase, every snapshot, every live write.
//
// The honesty rules are enforced HERE rather than left to whoever writes the
// report, because the report is exactly where the temptation lives:
//
//   - BEFORE is immutable. Once captured it is never re-run "because the
//     number looked bad". Re-capturing would let us shop for a flattering
//     baseline.
//   - BEFORE and AFTER must use the SAME urls, strategy and run count, or the
//     comparison is refused. Comparing a 3-run median against a lucky single
//     run is how honest people publish dishonest wins. Default is 5 runs:
//     Google documents the 5-run median as twice as stable as a single run.
//   - If a benchmark cloak was live during BEFORE, the pre-removal score is
//     FICTION. The project records that, and every later comparison must carry
//     the disclosure. (Learned the hard way: a store measured 97 while cloaked
//     and 78 once honest — real shoppers always had the 78 page.)

import fs from 'node:fs';
import path from 'node:path';

export const PHASES = ['initialized', 'before_captured', 'optimizing', 'after_captured', 'reported'];

const STATE_FILE = 'project.json';

export function projectRoot(baseDir, shop) {
  return path.join(baseDir, shop.replace(/\.myshopify\.com$/, ''));
}

export function loadProject(dir) {
  const file = path.join(dir, STATE_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveProject(dir, project) {
  fs.mkdirSync(dir, { recursive: true });
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(project, null, 2));
  return project;
}

export function initProject(dir, { shop, storefront, urls, strategy = 'mobile', runs = 5 }) {
  if (loadProject(dir)) throw new Error(`Project already exists at ${dir} — refusing to overwrite`);
  for (const sub of ['01-before', '02-optimization/backups', '03-after']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const project = {
    shop,
    storefront,
    createdAt: new Date().toISOString(),
    phase: 'initialized',
    // Frozen at init so BEFORE and AFTER cannot silently drift apart.
    measurement: { urls, strategy, runs },
    before: null,
    after: null,
    changes: [],
    notes: [],
  };
  return saveProject(dir, project);
}

/**
 * Record a captured snapshot. BEFORE is write-once: a second attempt is an
 * error, not an overwrite.
 */
export function recordSnapshot(dir, project, phase, snapshot) {
  if (phase === 'before' && project.before) {
    throw new Error(
      'BEFORE snapshot already exists and is immutable.\n' +
        `  Captured: ${project.before.capturedAt}\n` +
        '  Re-measuring the baseline would let us pick a flattering number.\n' +
        '  If the baseline is genuinely invalid (e.g. a cloak was removed), start a\n' +
        '  NEW project directory and say why in notes — do not overwrite history.'
    );
  }
  project[phase] = snapshot;
  project.phase = phase === 'before' ? 'before_captured' : 'after_captured';
  return saveProject(dir, project);
}

export function recordChange(dir, project, change) {
  project.changes.push({ at: new Date().toISOString(), ...change });
  if (project.phase === 'before_captured') project.phase = 'optimizing';
  return saveProject(dir, project);
}

/** Guard the comparison: same inputs, or no comparison. */
export function assertComparable(project) {
  const { before, after } = project;
  if (!before) throw new Error('No BEFORE snapshot — nothing to compare against.');
  if (!after) throw new Error('No AFTER snapshot yet. Run: speedkit snapshot <shop> --phase after');

  const problems = [];
  if (before.strategy !== after.strategy) {
    problems.push(`strategy differs (before=${before.strategy}, after=${after.strategy})`);
  }
  if (before.runs !== after.runs) {
    problems.push(`run count differs (before=${before.runs}, after=${after.runs})`);
  }
  const b = Object.keys(before.pages).sort().join(',');
  const a = Object.keys(after.pages).sort().join(',');
  if (b !== a) problems.push('page sets differ');

  if (problems.length) {
    throw new Error(
      `Refusing to compare — inputs are not equivalent:\n  - ${problems.join('\n  - ')}\n` +
        '  Re-run AFTER with the same measurement settings as BEFORE.'
    );
  }
}

/**
 * Disclosures a BEFORE snapshot forces onto every document derived from it.
 * ONE source of truth: `compare` and every client-facing report call this, so
 * the cloak warning and the run-count caveat cannot be forgotten by whoever
 * happens to be writing the deliverable.
 */
export function snapshotDisclosures(before) {
  const disclosures = [];
  if (before.cloakSuspected) {
    disclosures.push(
      'The BEFORE measurement was taken while benchmark-cloaking code was live. ' +
        'That score described a page real shoppers never received, so it is NOT a valid ' +
        'baseline: a lower AFTER number can mean the measurement became honest, not that ' +
        'the site got slower. Compare against the honest post-removal baseline instead.'
    );
  }
  // Google's own variability doc: "The median Lighthouse score of 5 runs is
  // twice as stable as 1 run." Anything under that is disclosed, not hidden.
  if (before.runs < 5) {
    disclosures.push(
      `Baseline used ${before.runs} run(s) per URL, below the 5-run median Google documents ` +
        'as twice as stable as a single run. Lab scores swing between runs; deltas smaller ' +
        'than that swing are not evidence of change.'
    );
  }
  return disclosures;
}

/**
 * Build the comparison. Reports per-page deltas from MEDIANS, and carries the
 * cloak disclosure when the baseline was measured on a cloaked page.
 */
export function buildComparison(project) {
  assertComparable(project);
  const { before, after } = project;
  const pages = Object.keys(before.pages);

  const rows = pages.map((url) => {
    const b = before.pages[url];
    const a = after.pages[url];
    const d = (x, y) => (typeof x === 'number' && typeof y === 'number' ? y - x : null);
    return {
      url,
      score: { before: b.score, after: a.score, delta: d(b.score, a.score) },
      lcpMs: { before: b.metrics.lcp, after: a.metrics.lcp, delta: d(b.metrics.lcp, a.metrics.lcp) },
      tbtMs: { before: b.metrics.tbt, after: a.metrics.tbt, delta: d(b.metrics.tbt, a.metrics.tbt) },
      clsValue: { before: b.metrics.cls, after: a.metrics.cls, delta: d(b.metrics.cls, a.metrics.cls) },
      runsBefore: b.scoreRuns,
      runsAfter: a.scoreRuns,
    };
  });

  const disclosures = snapshotDisclosures(before);
  return { pages: rows, disclosures, measurement: project.measurement, changes: project.changes };
}

export function formatComparison(cmp, project) {
  const L = [];
  const ms = (v) => (typeof v === 'number' ? `${Math.round(v)}ms` : '—');
  const sign = (v, unit = '') => {
    if (v === null || v === undefined) return '—';
    const r = Math.round(v * (unit === '' ? 1 : 1));
    return `${r > 0 ? '+' : ''}${r}${unit}`;
  };

  L.push(`\n${'═'.repeat(74)}`);
  L.push(`BEFORE → AFTER   ${project.shop}`);
  L.push(`${'═'.repeat(74)}`);
  L.push(`before: ${project.before.capturedAt}   after: ${project.after.capturedAt}`);
  L.push(`method: ${cmp.measurement.strategy}, median of ${cmp.measurement.runs} runs per URL\n`);

  for (const p of cmp.pages) {
    L.push(`▸ ${p.url}`);
    L.push(
      `    score  ${String(p.score.before).padStart(3)} → ${String(p.score.after).padStart(3)}   ` +
        `(${sign(p.score.delta)})   runs ${p.runsBefore.join('/')} → ${p.runsAfter.join('/')}`
    );
    L.push(`    LCP    ${ms(p.lcpMs.before).padStart(7)} → ${ms(p.lcpMs.after).padStart(7)}   (${sign(p.lcpMs.delta, 'ms')})`);
    L.push(`    TBT    ${ms(p.tbtMs.before).padStart(7)} → ${ms(p.tbtMs.after).padStart(7)}   (${sign(p.tbtMs.delta, 'ms')})`);
    L.push('');
  }

  if (cmp.changes.length) {
    L.push(`▸ CHANGES APPLIED (${cmp.changes.length})`);
    for (const c of cmp.changes) L.push(`    ${c.at.slice(0, 16).replace('T', ' ')}  ${c.summary}`);
    L.push('');
  }

  if (cmp.disclosures.length) {
    L.push(`▸ DISCLOSURES — these must appear in any client-facing report`);
    for (const d of cmp.disclosures) L.push(`    ⚠ ${d}`);
    L.push('');
  }
  return L.join('\n');
}
