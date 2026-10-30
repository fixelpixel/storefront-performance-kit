// Evidence collection — deterministic, no LLM.
//
// The analyzer is only as good as what it is given. A PSI "summary" (score +
// five opportunities) is NOT enough to diagnose: it cannot tell you whether LCP
// is late because the image is heavy or because the main thread is jammed, and
// that distinction changes the entire fix. So we pull the full Lighthouse
// result and extract the audits that actually carry signal, into a compact
// pack a model can reason over without drowning in JSON.

// Lighthouse renames audits between major versions, and PSI silently omits the
// ones that no longer exist. That is dangerous here: a missing audit read with
// `?? 0` becomes "0 bytes of savings", which reads as "already optimal" and
// gets reported as a measured fact.
//
// That is exactly what happened. On Lighthouse 13.4.1 the image audits are
// `image-delivery-insight`; we were reading the Lighthouse-11 names
// (`uses-optimized-images` et al), getting nothing, and concluding a store's
// images were perfect while 403 KiB of savings sat in the audit we never read.
//
// So: both generations are listed, and `derived` below distinguishes "measured
// zero" from "not measured". Never infer a rule-out from an absence.
const SIGNAL_AUDITS = [
  // Lighthouse 13 "insight" audits
  'lcp-breakdown-insight',
  'lcp-discovery-insight',
  'image-delivery-insight',
  'third-parties-insight',
  'render-blocking-insight',
  'document-latency-insight',
  'duplicated-javascript-insight',
  'legacy-javascript-insight',
  'font-display-insight',
  'cls-culprits-insight',
  'dom-size-insight',
  'network-dependency-tree-insight',
  'unsized-images',
  // Lighthouse 11/12 names, kept so older captures and other runners still work
  'largest-contentful-paint-element',
  'lcp-lazy-loaded',
  'prioritize-lcp-image',
  'render-blocking-resources',
  'third-party-summary',
  'uses-responsive-images',
  'modern-image-formats',
  'uses-optimized-images',
  'efficient-animated-content',
  'dom-size',
  'font-display',
  'layout-shift-elements',
  'critical-request-chains',
  'duplicated-javascript',
  'legacy-javascript',
  // stable across versions
  'unused-javascript',
  'unused-css-rules',
  'bootup-time',
  'mainthread-work-breakdown',
  'long-tasks',
  'server-response-time',
  'total-byte-weight',
];

/**
 * Savings in bytes from whichever image audit this Lighthouse version ships.
 * Returns null — NOT 0 — when no image audit is present, so a caller cannot
 * mistake "we did not measure it" for "there is nothing to save".
 */
function imageSavings(a) {
  const insight = a['image-delivery-insight'];
  if (insight) {
    const b = insight.details?.overallSavingsBytes ?? insight.details?.items?.reduce((s, i) => s + (i.wastedBytes || 0), 0);
    if (typeof b === 'number') return b;
    // Present but unparseable: fall back to the score rather than claiming zero.
    return insight.score === 1 ? 0 : null;
  }
  const legacy = ['uses-optimized-images', 'modern-image-formats', 'uses-responsive-images'].filter((id) => a[id]);
  if (!legacy.length) return null;
  return legacy.reduce((sum, id) => sum + (a[id].details?.overallSavingsBytes ?? 0), 0);
}

/** Is third-party impact negligible? null when no third-party audit exists. */
function thirdPartyNegligible(a) {
  const insight = a['third-parties-insight'];
  if (insight) return insight.score === 1;
  const legacy = a['third-party-summary'];
  if (legacy) return legacy.score === 1 || !(legacy.details?.items || []).length;
  return null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Flatten a Lighthouse table/opportunity into compact rows, capped. */
function compactItems(audit, limit = 12) {
  const items = audit?.details?.items;
  if (!Array.isArray(items)) return null;
  return items.slice(0, limit).map((it) => {
    const row = {};
    if (it.url) row.url = String(it.url).slice(0, 200);
    if (it.source?.url) row.url = String(it.source.url).slice(0, 200);
    if (typeof it.node?.snippet === 'string') row.node = it.node.snippet.slice(0, 200);
    if (typeof it.node?.selector === 'string') row.selector = it.node.selector.slice(0, 160);
    if (num(it.totalBytes) !== null) row.totalBytes = it.totalBytes;
    if (num(it.wastedBytes) !== null) row.wastedBytes = it.wastedBytes;
    if (num(it.wastedMs) !== null) row.wastedMs = Math.round(it.wastedMs);
    if (num(it.total) !== null) row.totalMs = Math.round(it.total);
    if (num(it.scripting) !== null) row.scriptingMs = Math.round(it.scripting);
    if (num(it.scriptParseCompile) !== null) row.parseMs = Math.round(it.scriptParseCompile);
    if (num(it.mainThreadTime) !== null) row.mainThreadMs = Math.round(it.mainThreadTime);
    if (num(it.blockingTime) !== null) row.blockingMs = Math.round(it.blockingTime);
    if (num(it.transferSize) !== null) row.transferBytes = it.transferSize;
    if (num(it.duration) !== null) row.durationMs = Math.round(it.duration);
    if (typeof it.groupLabel === 'string') row.group = it.groupLabel;
    if (typeof it.entity === 'string') row.entity = it.entity;
    if (it.entity?.text) row.entity = it.entity.text;
    if (typeof it.statistic === 'string') row.statistic = it.statistic;
    if (num(it.value) !== null) row.value = it.value;
    if (it.value?.value !== undefined) row.value = it.value.value;
    return row;
  });
}

/**
 * One Lighthouse run, with retries.
 *
 * PSI returns transient 500s and 429s often enough that a 5-run collection
 * without retries loses the whole capture to one bad request — and a 5-run
 * median is the thing we refuse to compromise on. 4xx other than 429 is a real
 * error (bad URL, bad key) and fails immediately rather than burning retries.
 */
export async function runLighthouse(url, strategy = 'mobile', { attempts = 4 } = {}) {
  const key = process.env.PAGESPEED_API_KEY;
  const api =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}` +
    `&strategy=${strategy}&category=performance${key ? `&key=${key}` : ''}`;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res;
    try {
      res = await fetch(api);
    } catch (err) {
      lastError = new Error(`PageSpeed request failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 4000));
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      if (data.lighthouseResult) return data.lighthouseResult;
      lastError = new Error('PageSpeed returned no lighthouseResult');
    } else if (res.status === 429 || res.status >= 500) {
      const hint = res.status === 429 && !key ? ' — keyless quota exhausted, set PAGESPEED_API_KEY' : '';
      lastError = new Error(`PageSpeed API ${res.status}${hint}`);
    } else {
      // 400/403 etc: retrying will not help, and pretending otherwise hides the cause.
      throw new Error(`PageSpeed API ${res.status} (not retryable — check the URL and PAGESPEED_API_KEY)`);
    }

    if (attempt < attempts) {
      process.stderr.write(`    (PSI ${lastError.message} — retry ${attempt}/${attempts - 1})\n`);
      await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }
  throw lastError;
}

/**
 * Build the evidence pack for one URL. `runs` > 1 takes the MEDIAN score run —
 * lab numbers swing ±8 points, and a single run is how people accidentally
 * report a best-case as if it were the truth.
 */
export async function collectEvidence(url, { strategy = 'mobile', runs = 1 } = {}) {
  const results = [];
  for (let i = 0; i < runs; i += 1) {
    results.push(await runLighthouse(url, strategy));
  }
  results.sort(
    (a, b) => (a.categories.performance?.score ?? 0) - (b.categories.performance?.score ?? 0)
  );
  const lh = results[Math.floor(results.length / 2)];
  const a = lh.audits;

  const metric = (id) => ({
    value: num(a[id]?.numericValue),
    display: a[id]?.displayValue ?? null,
  });

  const pack = {
    url: lh.finalUrl || url,
    // Recorded because audit IDs change between majors and a pack captured on
    // one version cannot be reasoned about with another version's field names.
    lighthouseVersion: lh.lighthouseVersion || null,
    strategy,
    runs,
    scoreRuns: results.map((r) => Math.round((r.categories.performance?.score ?? 0) * 100)),
    score: Math.round((lh.categories.performance?.score ?? 0) * 100),
    metrics: {
      lcp: metric('largest-contentful-paint'),
      tbt: metric('total-blocking-time'),
      fcp: metric('first-contentful-paint'),
      cls: metric('cumulative-layout-shift'),
      speedIndex: metric('speed-index'),
      ttfb: metric('server-response-time'),
      tti: metric('interactive'),
    },
    audits: {},
  };

  for (const id of SIGNAL_AUDITS) {
    const audit = a[id];
    if (!audit) continue;
    const entry = {
      title: audit.title,
      score: audit.score,
      display: audit.displayValue ?? null,
    };
    if (num(audit.numericValue) !== null) entry.numericValue = Math.round(audit.numericValue);
    const items = compactItems(audit);
    if (items?.length) entry.items = items;
    if (audit.details?.type === 'criticalrequestchain') {
      entry.note = 'critical chain present (see render-blocking)';
    }
    pack.audits[id] = entry;
  }

  // Derived signals the model would otherwise have to compute — and that are
  // easy to get subtly wrong. LCP-late vs LCP-heavy is THE fork in the road.
  const lcpMs = pack.metrics.lcp.value;
  const fcpMs = pack.metrics.fcp.value;
  const imgBytes = imageSavings(a);
  const tpNegligible = thirdPartyNegligible(a);
  const gap = typeof lcpMs === 'number' && typeof fcpMs === 'number' ? Math.round(lcpMs - fcpMs) : null;

  pack.derived = {
    lighthouseVersion: pack.lighthouseVersion,
    lcpMinusFcpMs: gap,
    // null means NOT MEASURED. Do not read it as "nothing to save".
    imageOptimizationSavingsBytes: imgBytes,
    imageAuditPresent: imgBytes !== null,
    thirdPartyNegligible: tpNegligible,
    unusedJsBytes: a['unused-javascript']?.details?.overallSavingsBytes ?? null,
    unusedCssBytes: a['unused-css-rules']?.details?.overallSavingsBytes ?? null,
    mainThreadTotalMs: typeof a['mainthread-work-breakdown']?.numericValue === 'number' ? Math.round(a['mainthread-work-breakdown'].numericValue) : null,
    jsBootupMs: typeof a['bootup-time']?.numericValue === 'number' ? Math.round(a['bootup-time'].numericValue) : null,
    // A HYPOTHESIS, and only when we actually measured the image side. If the
    // image audit is missing we say so instead of guessing: concluding
    // "LCP is late, not heavy" from an unread audit is how a whole engagement
    // gets pointed at the wrong lever.
    lcpLikelyBlockedNotHeavy: imgBytes === 0 && gap !== null && gap > 2000,
    lcpHeavyVsLateUndecidable:
      imgBytes === null ? 'image audit absent from this Lighthouse version — heavy-vs-late CANNOT be decided from this pack' : null,
  };

  return pack;
}
