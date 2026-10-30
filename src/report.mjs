// Report generator — one pipeline, three client-facing documents.
//
//   free   — lead magnet. Score, ONE headline cause in merchant language, what
//            it costs. Deliberately WITHHOLDS the ranked fixes, file names and
//            the how: that is the paid product.
//   paid   — the extended audit. Verdict, what is RULED OUT, ranked causes with
//            confidence, ranked fixes with effort/risk/QA, and the frozen
//            baseline table. This document IS the BEFORE record.
//   final  — before → after from `compare`, carrying its disclosures VERBATIM,
//            plus what did NOT improve and what remains.
//
// The honesty rules live in the RENDERER, not in whoever runs it:
//   - disclosures come from snapshotDisclosures()/buildComparison() and are
//     injected automatically — a cloaked or under-sampled baseline cannot ship
//     without its warning;
//   - null renders as "—", never 0 — a missing measurement is not a zero;
//   - confidence labels are printed as-is; "probable" is never laundered into
//     fact for readability;
//   - no copy anywhere promises a score or metric gain — mechanism and
//     direction only;
//   - this module never imports the knowledge base: findings carry other
//     clients' names in `seenAt`, and nothing from one engagement may appear
//     in another client's document (there is a test for this).
//
// Output is a single self-contained HTML file — no external fonts, scripts,
// stylesheets or images — that prints to PDF cleanly from any browser.

import { buildComparison, snapshotDisclosures } from './project.mjs';

const BRAND = process.env.SPEEDKIT_BRAND || 'Storefront performance';

// --- formatting: null is "—", never 0 --------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const DASH = '—';

const fmtScore = (v) => (isNum(v) ? String(Math.round(v)) : DASH);
const fmtMs = (v) => (isNum(v) ? (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`) : DASH);
const fmtCls = (v) => (isNum(v) ? String(Math.round(v * 1000) / 1000) : DASH);
const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : DASH);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** The free report withholds file names — scrub them from any text it shows. */
export function scrubFileNames(text) {
  return String(text ?? '').replace(/\b[\w@/.-]*\w\.(?:m?js|css|liquid|json)\b/gi, 'a code file');
}

// --- shared page shell ------------------------------------------------------

// Google's Core Web Vitals thresholds. A number on its own tells a merchant
// nothing — "LCP 2.1s" is meaningless until you know 2.5s is the line. Every
// metric in these documents is rendered against its band, so the reader can
// see where they stand without being told.
//
// `lower` = lower is better (all of these). `bands` = [goodMax, needsMax].
const THRESHOLDS = {
  score: { bands: [50, 90], higherIsBetter: true, label: 'Performance score' },
  lcp: { bands: [2500, 4000], label: 'LCP' },
  inp: { bands: [200, 500], label: 'INP' },
  tbt: { bands: [200, 600], label: 'TBT' },
  fcp: { bands: [1800, 3000], label: 'FCP' },
  cls: { bands: [0.1, 0.25], label: 'CLS' },
  si: { bands: [3400, 5800], label: 'Speed Index' },
};

/** Which band a value falls in: good | needs | poor | null when unmeasured. */
export function metricBand(key, value) {
  const t = THRESHOLDS[key];
  if (!t || typeof value !== 'number' || !Number.isFinite(value)) return null;
  const [a, b] = t.bands;
  if (t.higherIsBetter) return value >= b ? 'good' : value >= a ? 'needs' : 'poor';
  return value <= a ? 'good' : value <= b ? 'needs' : 'poor';
}

const BAND_LABEL = { good: 'Good', needs: 'Needs work', poor: 'Poor' };

/**
 * A threshold meter: the three bands drawn to scale with a marker where this
 * store actually sits. Unmeasured values render the track with NO marker and
 * say so — never a marker at zero, which would read as a perfect result.
 */
function meter(key, value) {
  const t = THRESHOLDS[key];
  const band = metricBand(key, value);
  if (!t) return '';
  if (!band) {
    return `<div class="meter"><div class="track"><i class="b good"></i><i class="b needs"></i><i class="b poor"></i></div>
      <div class="mlabel muted">not measured</div></div>`;
  }
  const [a, b] = t.bands;
  // Scale: good band 0-40%, needs 40-70%, poor 70-100%. Position within band.
  let pos;
  if (t.higherIsBetter) {
    pos = value >= b ? 85 : value >= a ? 40 + ((value - a) / (b - a)) * 30 : (value / a) * 40;
  } else {
    pos = value <= a ? (value / a) * 40 : value <= b ? 40 + ((value - a) / (b - a)) * 30 : Math.min(97, 70 + ((value - b) / b) * 30);
  }
  return `<div class="meter"><div class="track"><i class="b good"></i><i class="b needs"></i><i class="b poor"></i>
      <u class="mark ${band}" style="left:${pos.toFixed(1)}%"></u></div>
    <div class="mlabel ${band}">${BAND_LABEL[band]}</div></div>`;
}

const CSS = `
  * { box-sizing: border-box; }
  :root {
    --ink: #10161d; --ink-2: #4a5563; --ink-3: #7b8794;
    --line: #e3e8ed; --line-2: #cbd3db; --paper: #fff; --tint: #f6f8fa;
    --good: #10794a; --good-bg: #e7f4ec;
    --needs: #9a6100; --needs-bg: #fdf3e0;
    --poor: #a5231f; --poor-bg: #fbeceb;
    --accent: #10161d;
  }
  body { margin: 0; background: var(--paper); color: var(--ink);
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         -webkit-font-smoothing: antialiased; }
  .doc { max-width: 860px; margin: 0 auto; padding: 52px 56px 64px; }

  /* masthead */
  .masthead { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px;
              border-bottom: 2px solid var(--accent); padding-bottom: 16px; margin-bottom: 8px; }
  .mast-left { min-width: 0; }
  .brand { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
  .stage { flex: none; align-self: flex-end; white-space: nowrap; font-size: 10px; letter-spacing: .12em;
           text-transform: uppercase; background: var(--accent); color: #fff; padding: 5px 12px;
           border-radius: 2px; font-weight: 600; }
  h1 { font-size: 30px; letter-spacing: -.02em; margin: 10px 0 3px; line-height: 1.15; }
  .sub { color: var(--ink-2); font-size: 13.5px; }

  h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3);
       border-bottom: 1px solid var(--line); padding-bottom: 7px; margin: 36px 0 14px; font-weight: 700; }
  h3 { font-size: 15px; margin: 18px 0 6px; }
  p { margin: 9px 0; }

  /* tables */
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin: 6px 0; }
  th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--ink-3); border-bottom: 1.5px solid var(--line-2); padding: 8px; font-weight: 700; }
  td { border-bottom: 1px solid var(--line); padding: 9px 8px; vertical-align: middle; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
  .muted { color: var(--ink-2); } .small { font-size: 12px; }

  /* threshold meter — the thing that makes a number mean something */
  .meter { min-width: 132px; }
  .track { position: relative; display: flex; height: 7px; border-radius: 4px; overflow: hidden; background: var(--line); }
  .track .b { display: block; height: 100%; }
  .track .b.good { width: 40%; background: #bfe3ce; }
  .track .b.needs { width: 30%; background: #f6ddb0; }
  .track .b.poor { width: 30%; background: #f2c3c0; }
  .track .mark { position: absolute; top: -3px; width: 3px; height: 13px; border-radius: 2px;
                 transform: translateX(-1.5px); background: var(--ink); }
  .track .mark.good { background: var(--good); }
  .track .mark.needs { background: var(--needs); }
  .track .mark.poor { background: var(--poor); }
  .mlabel { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; margin-top: 4px; font-weight: 700; }
  .mlabel.good { color: var(--good); } .mlabel.needs { color: var(--needs); } .mlabel.poor { color: var(--poor); }

  /* verdict block — the answer in three seconds */
  .verdict { display: grid; grid-template-columns: 128px 1fr; gap: 26px; align-items: center;
             border: 1px solid var(--line-2); border-radius: 6px; padding: 22px 24px; margin: 22px 0 8px; }
  .dial { text-align: center; }
  .dial .n { font-size: 58px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -.03em; }
  .dial .n.good { color: var(--good); } .dial .n.needs { color: var(--needs); } .dial .n.poor { color: var(--poor); }
  .dial .cap { font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--ink-3); margin-top: 6px; font-weight: 700; }
  .verdict .say { font-size: 15.5px; line-height: 1.55; }

  /* callouts */
  .disclosure { background: var(--needs-bg); border: 1px solid #e6c98a; border-left: 5px solid var(--needs);
                border-radius: 4px; padding: 14px 18px; margin: 16px 0; color: #5c3f00; }
  .disclosure .dtitle { font-weight: 700; text-transform: uppercase; font-size: 10.5px; letter-spacing: .1em; margin-bottom: 4px; }
  .callout { border: 1px solid var(--line-2); border-left: 5px solid var(--accent); border-radius: 4px;
             padding: 14px 18px; margin: 16px 0; }
  .box { border: 1px solid var(--line); background: var(--tint); border-radius: 4px; padding: 14px 18px; margin: 16px 0; }

  .better { color: var(--good); font-weight: 700; }
  .worse { color: var(--poor); font-weight: 700; }
  .flat { color: var(--ink-3); }

  .badge { display: inline-block; font-size: 10px; letter-spacing: .07em; text-transform: uppercase;
           padding: 3px 9px; border-radius: 11px; border: 1px solid var(--line-2); color: var(--ink-2);
           white-space: nowrap; font-weight: 700; }
  .badge.confirmed { border-color: var(--good); color: var(--good); background: var(--good-bg); }
  .badge.high { border-color: #2b6cb0; color: #2b6cb0; }

  ul { margin: 7px 0; padding-left: 22px; } li { margin: 5px 0; }
  footer { margin-top: 48px; border-top: 1px solid var(--line); padding-top: 14px; color: var(--ink-3); font-size: 11.5px; }
  section { break-inside: avoid; }

  @media print {
    .doc { padding: 0; max-width: none; }
    body { font-size: 11.5px; }
    h2 { margin-top: 22px; }
    .verdict, .disclosure, .callout, .box, table { break-inside: avoid; }
    h2, h3 { break-after: avoid; }
  }
  @page { margin: 15mm; }
`;

function page({ stageTag, title, subtitle, body, generatedAt }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="doc">
  <header class="masthead">
    <div class="mast-left">
      <div class="brand">${esc(BRAND)} — Shopify Speed Practice</div>
      <h1>${esc(title)}</h1>
      <div class="sub">${esc(subtitle)}</div>
    </div>
    <span class="stage">${esc(stageTag)}</span>
  </header>
${body}
  <footer>
    <div>${esc(BRAND)} · generated ${esc(fmtDate(generatedAt))} · Lab metrics (Lighthouse) are diagnostics, not a promise about real users — field data (CrUX p75) is what shoppers actually experience.</div>
    <div>This document states mechanisms and direction only. It deliberately contains no predicted score or metric gains: those cannot be promised honestly, and anyone who does is selling a number, not an outcome.</div>
  </footer>
</div>
</body>
</html>`;
}

function disclosureBlock(disclosures, title = 'Read this first — required disclosures') {
  if (!disclosures.length) return '';
  return `<section class="disclosure"><div class="dtitle">${esc(title)}</div>${disclosures
    .map((d) => `<p>${esc(d)}</p>`)
    .join('')}</section>`;
}

// --- FREE / basic audit ------------------------------------------------------
//
// Withholds: ranked fixes, file names, the how. Shows: score, the one headline
// cause in plain language, what it costs. Disclosures still ride along.

export function renderFreeReport({ label, diagnosis, evidence, generatedAt = new Date().toISOString() }) {
  if (!diagnosis || !evidence) throw new Error('Free report needs a diagnosis + evidence (run: speedkit diagnose <url> --json).');

  const m = evidence.metrics || {};
  const val = (k) => (m[k] && isNum(m[k].value) ? m[k].value : null);
  const runs = evidence.scoreRuns || [];
  const runsNote =
    runs.length >= 5
      ? `Median of ${runs.length} runs.`
      : runs.length > 1
        ? `Median of ${runs.length} runs — our full baseline uses the median of 5, which Google documents as twice as stable as a single run.`
        : 'Single lab run — Lighthouse scores swing several points between runs, so treat this as directional, not as a baseline.';

  const thresholds = [
    ['Largest Contentful Paint (when the main content appears)', val('lcp'), 2500, fmtMs, '2.5 s'],
    ['First Contentful Paint (when anything appears)', val('fcp'), 1800, fmtMs, '1.8 s'],
    ['Total Blocking Time (how long the page ignores taps)', val('tbt'), 200, fmtMs, '200 ms'],
    ['Cumulative Layout Shift (how much the page jumps around)', val('cls'), 0.1, fmtCls, '0.1'],
  ];
  const thresholdRows = thresholds
    .map(([labelTxt, v, limit, f, limitTxt]) => {
      const status = v === null ? DASH : v <= limit ? '<span class="better">OK</span>' : '<span class="worse">Needs work</span>';
      return `<tr><td>${esc(labelTxt)}</td><td class="num">${esc(f(v))}</td><td class="num muted">${esc(limitTxt)}</td><td>${status}</td></tr>`;
    })
    .join('\n');

  const headlineCause = diagnosis.rootCauses?.length
    ? scrubFileNames([...diagnosis.rootCauses].sort((a, b) => a.rank - b.rank)[0].cause)
    : null;
  const summary = scrubFileNames(diagnosis.clientSummary || '');

  const disclosures = [];
  if (diagnosis.baselineTrustworthy === false) {
    disclosures.push(
      (diagnosis.baselineWarning || 'The measured number cannot be trusted as a baseline.') +
        ' If a measurement gate like this is removed, a lower score afterwards means the measurement became honest, not that the site regressed.'
    );
  }

  const costLines = [];
  const lcp = val('lcp');
  const tbt = val('tbt');
  if (lcp !== null && lcp > 2500) {
    costLines.push(
      `In this measurement, a mobile shopper waits ${fmtMs(lcp)} before the main content appears — Google's "good" threshold is 2.5 s. Every visit spends that time looking at an incomplete page, and that is the window where shoppers give up.`
    );
  }
  if (tbt !== null && tbt > 200) {
    costLines.push(
      `The page was unresponsive to input for ${fmtMs(tbt)} of blocking time during load — taps and scrolls queue up instead of reacting.`
    );
  }
  if (!costLines.length) {
    costLines.push(
      'The core lab metrics are inside Google’s "good" thresholds. If this holds up across more pages and more runs, this store does not urgently need speed work — and we would rather tell you that than sell you an engagement.'
    );
  }

  const body = `
${disclosureBlock(disclosures)}
<section>
  <div class="verdict">
    <div class="dial">
      <div class="n ${metricBand('score', evidence.score) || 'flat'}">${esc(fmtScore(evidence.score))}</div>
      <div class="cap">of 100 · ${esc(evidence.strategy || 'mobile')}</div>
    </div>
    <div class="say">
      ${headlineCause ? `<strong>${esc(headlineCause)}</strong>` : `<strong>No dominant root cause stood out in this check.</strong>`}
      ${summary ? `<p class="muted" style="margin:8px 0 0">${esc(summary)}</p>` : ''}
    </div>
  </div>
  <p class="muted small">${esc(runsNote)}</p>
</section>
<section>
  <h2>How the store measures against Google's thresholds</h2>
  <table><thead><tr><th>What we measured</th><th class="num">This store</th><th class="num">Good is</th><th>Status</th></tr></thead>
  <tbody>${thresholdRows}</tbody></table>
  <p class="muted small">${DASH} means the metric was not captured in this run. A missing measurement is not a zero.</p>
</section>
<section>
  <h2>The one thing holding this store back</h2>
  ${headlineCause ? `<div class="callout"><strong>${esc(headlineCause)}</strong></div>` : `<p class="muted">No dominant root cause stood out in this check.</p>`}
  ${summary ? `<p>${esc(summary)}</p>` : ''}
</section>
<section>
  <h2>What this costs you</h2>
  ${costLines.map((c) => `<p>${esc(c)}</p>`).join('\n')}
</section>
<section>
  <h2>What the full audit adds</h2>
  <div class="box">
    <p>This free check names the headline problem. The paid extended audit is the working document an engagement runs on:</p>
    <ul>
      <li>every root cause, ranked, each with a confidence label and the evidence behind it;</li>
      <li>which popular fixes would waste money on this particular store — eliminated before you pay for them;</li>
      <li>a prioritized fix plan with sizing, risk and the QA each change needs (nothing touches cart or checkout without a test plan);</li>
      <li>a frozen 5-run baseline, so the after-work report is measured against an honest, unshoppable number.</li>
    </ul>
  </div>
</section>`;

  return page({
    stageTag: 'Free speed check',
    title: 'Storefront speed check',
    subtitle: `${label} · measured ${fmtDate(generatedAt)}`,
    body,
    generatedAt,
  });
}

// --- PAID / extended audit — this IS the BEFORE record ------------------------

const CONFIDENCE_ORDER = ['confirmed', 'high', 'probable', 'possible'];

function confidenceBadge(c) {
  const label = CONFIDENCE_ORDER.includes(c) ? c : String(c || 'unlabelled');
  return `<span class="badge ${esc(label)}">${esc(label)}</span>`;
}

function baselineTable(before, measurement) {
  const rows = Object.entries(before.pages)
    .map(([url, p]) => {
      const mm = p.metrics || {};
      return `<tr>
  <td>${esc(url)}</td>
  <td class="num">${esc(fmtScore(p.score))}</td>
  <td class="num muted">${esc((p.scoreRuns || []).map(fmtScore).join(' / ') || DASH)}</td>
  <td class="num">${esc(fmtMs(mm.lcp))}</td>
  <td class="num">${esc(fmtMs(mm.tbt))}</td>
  <td class="num">${esc(fmtMs(mm.fcp))}</td>
  <td class="num">${esc(fmtCls(mm.cls))}</td>
</tr>`;
    })
    .join('\n');
  return `<table><thead><tr><th>Page</th><th class="num">Score (median)</th><th class="num">Individual runs</th><th class="num">LCP</th><th class="num">TBT</th><th class="num">FCP</th><th class="num">CLS</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted small">Medians of ${esc(String(measurement.runs))} run(s) per page (${esc(measurement.strategy)}); the individual runs are shown because lab scores swing between runs. ${DASH} means the value was not captured — a missing measurement is not a zero.</p>`;
}

export function renderPaidReport({ project, diagnosis, generatedAt = new Date().toISOString() }) {
  if (!project?.before) {
    throw new Error('Paid report requires the frozen BEFORE snapshot (run: speedkit snapshot <shop> --phase before).');
  }
  if (!diagnosis) {
    throw new Error('Paid report requires a stored diagnosis (run: speedkit diagnose <url> --runs 5 --json, or --save <shop>).');
  }

  const disclosures = snapshotDisclosures(project.before);
  if (diagnosis.baselineTrustworthy === false && diagnosis.baselineWarning && !project.before.cloakSuspected) {
    disclosures.push(diagnosis.baselineWarning);
  }

  const ruledOut = (diagnosis.ruledOut || [])
    .map((r) => `<tr><td><strong>${esc(r.cause)}</strong></td><td>${esc(r.evidence)}</td></tr>`)
    .join('\n');

  const causes = [...(diagnosis.rootCauses || [])]
    .sort((a, b) => a.rank - b.rank)
    .map(
      (c) => `<tr>
  <td class="num">${esc(String(c.rank))}</td>
  <td>${confidenceBadge(c.confidence)}</td>
  <td><strong>${esc(c.cause)}</strong><div class="muted small">affects: ${esc((c.affects || []).join(', ') || DASH)}</div></td>
  <td class="small">${esc(c.evidence)}</td>
</tr>`
    )
    .join('\n');

  const fixes = [...(diagnosis.fixes || [])]
    .sort((a, b) => a.rank - b.rank)
    .map((f) => {
      const qa = (f.requiresQA || []).filter((q) => q && q !== 'none');
      return `<tr>
  <td class="num">${esc(String(f.rank))}</td>
  <td><strong>${esc(f.title)}</strong>
      <div class="small">${esc(f.what)}</div>
      ${f.mechanism ? `<div class="muted small">why it works: ${esc(f.mechanism)}</div>` : ''}</td>
  <td class="small">${esc(f.where || DASH)}</td>
  <td class="num">${esc(f.effort || DASH)}</td>
  <td class="num">${esc(f.risk || DASH)}${f.reversible === false ? '<div class="worse small">not reversible</div>' : ''}</td>
  <td class="small">${qa.length ? `⚠ ${esc(qa.join(', '))}` : '<span class="muted">none</span>'}</td>
</tr>`;
    })
    .join('\n');

  const matched = (diagnosis.matchedFindings || []).length;

  const body = `
<section class="box">
  <p><strong>This document is the frozen BEFORE record for the engagement.</strong> The measurement method below was locked when the project was created; the after-work report must use the same pages, device profile and run count, and the tooling refuses to compare anything else.</p>
  <p class="small muted">Method: ${esc(project.measurement.strategy)} · median of ${esc(String(project.measurement.runs))} runs per page · baseline captured ${esc(fmtDate(project.before.capturedAt))}<br>
  Pages: ${project.measurement.urls.map((u) => esc(u)).join(' · ')}</p>
</section>
${disclosureBlock(disclosures)}
<section>
  <h2>Verdict</h2>
  <p>${esc(diagnosis.verdict || DASH)}</p>
  ${diagnosis.clientSummary ? `<p class="muted">${esc(diagnosis.clientSummary)}</p>` : ''}
</section>
<section>
  <h2>Ruled out — do not spend money here</h2>
  ${ruledOut ? `<table><thead><tr><th>Popular fix that will NOT help this store</th><th>Why we ruled it out</th></tr></thead><tbody>${ruledOut}</tbody></table>` : '<p class="muted">Nothing was ruled out with confidence in this diagnosis.</p>'}
</section>
<section>
  <h2>Root causes, ranked</h2>
  ${causes ? `<table><thead><tr><th class="num">#</th><th>Confidence</th><th>Cause</th><th>Evidence</th></tr></thead><tbody>${causes}</tbody></table>` : '<p class="muted">No root causes were established.</p>'}
  <p class="muted small">Confidence labels are preserved exactly: <strong>confirmed</strong> means we measured it directly on this store; high / probable / possible are decreasing strengths of inference. A "probable" cause is a hypothesis, not a fact.</p>
</section>
<section>
  <h2>Fix plan, ranked</h2>
  ${fixes ? `<table><thead><tr><th class="num">#</th><th>Fix</th><th>Where</th><th class="num">Effort</th><th class="num">Risk</th><th>QA required</th></tr></thead><tbody>${fixes}</tbody></table>` : '<p class="muted">No fixes proposed.</p>'}
  <p class="muted small">Effort: S/M/L. Any fix touching cart, checkout, variants or tracking carries a QA flag — those flows are tested before and after the change, because a broken add-to-cart costs more than any speed win.</p>
</section>
${
  (diagnosis.doNotDo || []).length
    ? `<section><h2>Do not do</h2><ul>${diagnosis.doNotDo.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`
    : ''
}
${
  (diagnosis.openQuestions || []).length
    ? `<section><h2>Open questions</h2><ul>${diagnosis.openQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul><p class="muted small">Where the evidence could not settle something, we say so rather than guess.</p></section>`
    : ''
}
<section>
  <h2>Frozen baseline — the BEFORE table</h2>
  ${baselineTable(project.before, project.measurement)}
</section>
${matched ? `<section><p class="muted small">${matched} of the patterns above match findings we have measured on previous engagements; the diagnosis weighs measured patterns above generic advice. No detail from any other engagement appears in this document.</p></section>` : ''}`;

  return page({
    stageTag: 'Extended audit',
    title: 'Speed audit — extended',
    subtitle: `${project.storefront || project.shop} · baseline ${fmtDate(project.before.capturedAt)}`,
    body,
    generatedAt,
  });
}

// --- FINAL / reporting audit ---------------------------------------------------

const METRIC_DEFS = [
  { key: 'score', label: 'Performance score', better: 'up', fmt: fmtScore, band: 'score' },
  { key: 'lcpMs', label: 'LCP', better: 'down', fmt: fmtMs, band: 'lcp' },
  { key: 'tbtMs', label: 'TBT', better: 'down', fmt: fmtMs, band: 'tbt' },
  { key: 'clsValue', label: 'CLS', better: 'down', fmt: fmtCls, band: 'cls' },
];

function deltaCell(delta, better, fmt) {
  if (!isNum(delta)) return `<span class="flat">${DASH}</span>`;
  if (delta === 0) return `<span class="flat">±0</span>`;
  const improved = better === 'up' ? delta > 0 : delta < 0;
  const sign = delta > 0 ? '+' : '−';
  return `<span class="${improved ? 'better' : 'worse'}">${sign}${fmt(Math.abs(delta))}</span>`;
}

/** Everything that did NOT improve — the section wins are not allowed to bury. */
export function collectNotImproved(cmp) {
  const rows = [];
  for (const p of cmp.pages) {
    for (const d of METRIC_DEFS) {
      const m = p[d.key];
      if (!m) continue;
      if (!isNum(m.delta)) {
        rows.push({ url: p.url, metric: d.label, note: 'not measured on both sides — no improvement is claimed', before: m.before ?? null, after: m.after ?? null, fmt: d.fmt });
        continue;
      }
      const improved = d.better === 'up' ? m.delta > 0 : m.delta < 0;
      if (!improved) {
        rows.push({
          url: p.url,
          metric: d.label,
          note: m.delta === 0 ? 'unchanged' : 'worse than the baseline',
          before: m.before,
          after: m.after,
          fmt: d.fmt,
        });
      }
    }
  }
  return rows;
}

/**
 * "What remains": fixes from the stored diagnosis that no logged change claims.
 * Matching is deliberately mechanical (change.fixRank, or the fix title quoted
 * in a change summary) — if work was done but never logged, it shows up here,
 * which is the incentive to log it.
 */
export function collectRemaining(diagnosis, changes) {
  if (!diagnosis) return null;
  const summaries = (changes || []).map((c) => String(c.summary || '').toLowerCase());
  const ranks = new Set((changes || []).map((c) => c.fixRank).filter((r) => r != null));
  return [...(diagnosis.fixes || [])]
    .sort((a, b) => a.rank - b.rank)
    .filter((f) => !ranks.has(f.rank) && !summaries.some((s) => s.includes(String(f.title || '').toLowerCase())));
}

export function renderFinalReport({ project, diagnosis = null, generatedAt = new Date().toISOString() }) {
  const cmp = buildComparison(project); // refuses non-equivalent inputs; brings disclosures

  const pageBlocks = cmp.pages
    .map((p) => {
      const rows = METRIC_DEFS.map((d) => {
        const m = p[d.key];
        // The meter shows where the AFTER value lands against Google's bands —
        // a delta alone cannot tell a merchant whether they are actually good now.
        return `<tr><td>${esc(d.label)}</td><td class="num">${esc(d.fmt(m.before))}</td><td class="num">${esc(d.fmt(m.after))}</td><td class="num">${deltaCell(m.delta, d.better, d.fmt)}</td><td>${meter(d.band, m.after)}</td></tr>`;
      }).join('\n');
      return `<section>
  <h2>${esc(p.url)}</h2>
  <table><thead><tr><th>Metric</th><th class="num">Before</th><th class="num">After</th><th class="num">Change</th><th>Where it lands now</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="muted small">Score runs — before: ${esc((p.runsBefore || []).map(fmtScore).join(' / ') || DASH)} · after: ${esc((p.runsAfter || []).map(fmtScore).join(' / ') || DASH)}. Medians are reported, never the best run.</p>
</section>`;
    })
    .join('\n');

  const changes = (cmp.changes || [])
    .map((c) => `<li><span class="muted small">${esc(String(c.at || '').slice(0, 16).replace('T', ' '))}</span> — ${esc(c.summary)}</li>`)
    .join('\n');

  const notImproved = collectNotImproved(cmp);
  const notImprovedHtml = notImproved.length
    ? `<table><thead><tr><th>Page</th><th>Metric</th><th class="num">Before</th><th class="num">After</th><th>Status</th></tr></thead><tbody>${notImproved
        .map(
          (r) =>
            `<tr><td class="small">${esc(r.url)}</td><td>${esc(r.metric)}</td><td class="num">${esc(r.fmt(r.before))}</td><td class="num">${esc(r.fmt(r.after))}</td><td class="small">${esc(r.note)}</td></tr>`
        )
        .join('\n')}</tbody></table>`
    : `<p>Every tracked metric improved on every measured page. That sentence is computed from the table above, not written by hand.</p>`;

  const remaining = collectRemaining(diagnosis, cmp.changes);
  let remainingHtml;
  if (remaining === null) {
    remainingHtml = `<p class="muted">No stored diagnosis was found for this project, so the remaining-work list cannot be produced automatically. ${DASH}</p>`;
  } else if (remaining.length) {
    remainingHtml = `<ul>${remaining
      .map((f) => `<li><strong>${esc(f.title)}</strong> <span class="muted small">[effort ${esc(f.effort || DASH)} · risk ${esc(f.risk || DASH)}]</span>${f.mechanism ? `<div class="muted small">${esc(f.mechanism)}</div>` : ''}</li>`)
      .join('')}</ul>
<p class="muted small">Listed because no logged change claims them. Work done but not logged would appear here — logging is what earns the credit.</p>`;
  } else {
    remainingHtml = `<p>Every fix proposed in the audit has a logged change against it. The ceiling beyond this plan (theme rebuild, app consolidation) was out of scope for this engagement.</p>`;
  }

  const body = `
${disclosureBlock(cmp.disclosures, 'Required disclosures — read before the numbers')}
<section class="box">
  <p class="small muted">Baseline captured ${esc(fmtDate(project.before.capturedAt))} · after-work measurement ${esc(fmtDate(project.after.capturedAt))} · method: ${esc(cmp.measurement.strategy)}, median of ${esc(String(cmp.measurement.runs))} runs per page — identical on both sides, enforced by the tooling.</p>
</section>
${pageBlocks}
<section>
  <h2>Changes applied during the engagement</h2>
  ${changes ? `<ul>${changes}</ul>` : '<p class="muted">No changes were logged.</p>'}
  <p class="muted small">Changes are listed chronologically. The before/after delta belongs to the engagement as a whole; this report makes no per-change causal claim, because no single change was measured in isolation.</p>
</section>
<section>
  <h2>What did not improve</h2>
  ${notImprovedHtml}
</section>
<section>
  <h2>What remains</h2>
  ${remainingHtml}
</section>`;

  return page({
    stageTag: 'Results report',
    title: 'Speed engagement — results',
    subtitle: `${project.storefront || project.shop} · ${fmtDate(project.before.capturedAt)} → ${fmtDate(project.after.capturedAt)}`,
    body,
    generatedAt,
  });
}

// --- dispatcher ----------------------------------------------------------------

export const STAGES = ['free', 'paid', 'final'];

export function renderReport(stage, ctx) {
  if (stage === 'free') return renderFreeReport(ctx);
  if (stage === 'paid') return renderPaidReport(ctx);
  if (stage === 'final') return renderFinalReport(ctx);
  throw new Error(`Unknown report stage "${stage}" — use one of: ${STAGES.join(' | ')}`);
}
