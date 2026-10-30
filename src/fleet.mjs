// Fleet scanner — turn the stores we already have access to into our own
// empirical dataset.
//
// Why this is worth building: every prevalence number in this industry comes
// from someone else's population. Shopify says 59-82% of pages lazy-load their
// LCP image; a vendor says each app costs 2-3 points. We can measure OUR fleet
// and know, rather than cite.
//
// It also answers a question we currently cannot answer: how many of the stores
// we are responsible for are running a benchmark cloak right now.
//
// TWO TIERS, deliberately:
//   cheap  — fetch the storefront + its scripts, run the detectors. No PSI
//            quota, no API key, fast enough for the whole fleet.
//   psi    — full Lighthouse. Rate-limited, so sample rather than sweep.
//
// PRIVACY: per-store results stay LOCAL (gitignored). Only AGGREGATES go into
// the knowledge base. A client's storefront problems are not material we hand
// to another client, and a KB that names them would do exactly that.

import { auditStorefront, fetchText } from './audit.mjs';

/** Images early in the document — the LCP candidate is almost always here. */
function analyzeEarlyImages(html, limit = 5) {
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].slice(0, limit).map((m) => m[0]);
  if (!imgs.length) return { count: 0, lazy: 0, firstIsLazy: null, anyFetchPriority: false };
  const isLazy = (tag) => /loading\s*=\s*["']?lazy/i.test(tag);
  return {
    count: imgs.length,
    lazy: imgs.filter(isLazy).length,
    firstIsLazy: isLazy(imgs[0]),
    anyFetchPriority: imgs.some((t) => /fetchpriority\s*=\s*["']?high/i.test(t)),
  };
}

/** Third-party hosts, so we can rank which vendors our fleet actually carries. */
function thirdPartyHosts(html, pageUrl) {
  const hosts = new Set();
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).host;
  } catch {
    /* ignore */
  }
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const h = new URL(m[1], pageUrl).host;
      if (h && h !== pageHost && !h.endsWith('cdn.shopify.com')) hosts.add(h);
    } catch {
      /* ignore */
    }
  }
  return [...hosts];
}

/** Signals that a "speed optimizer" has been installed by someone else. */
const OPTIMIZER_HINTS = [
  { pattern: /hyperspeed/i, label: 'hyperspeed' },
  { pattern: /\bswift[-_.]?(?:speed|optimiz)/i, label: 'swift-speed' },
  { pattern: /booster[-_.]?(?:page)?speed|page[-_.]?speed[-_.]?optimizer/i, label: 'booster/page-speed-optimizer' },
  { pattern: /nitro[-_.]?(?:speed|boost)/i, label: 'nitro-like' },
  { pattern: /(?:pre-?loader|optimizer|asyncloadlayout)\.js/i, label: 'field-observed cloaker filename' },
  { pattern: /rapid[-_.]?load|turbo[-_.]?boost/i, label: 'turbo/rapid-load' },
];

export async function scanStore(target, { fetchScripts = true } = {}) {
  const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const report = await auditStorefront(url, { fetchScripts, maxScripts: 25 });
  if (!report.ok) return { input: target, ok: false, error: report.error };

  // auditStorefront follows redirects, so report.url is the real storefront
  // (myshopify domains redirect to the merchant's primary domain).
  const page = await fetchText(report.url);
  const html = page.ok ? page.body : '';

  const optimizers = OPTIMIZER_HINTS.filter((h) => h.pattern.test(html)).map((h) => h.label);

  return {
    input: target,
    ok: true,
    url: report.url,
    cloakSuspected: report.cloakSuspected,
    duplicates: report.duplicates,
    duplicateCount: report.duplicates.length,
    maxDuplicateLoads: report.duplicates[0]?.loadedTimes ?? 0,
    scripts: report.scripts,
    earlyImages: analyzeEarlyImages(html),
    thirdPartyHosts: thirdPartyHosts(html, report.url),
    optimizerHints: optimizers,
    // OPAQUE ≠ cloak: deliberately unreadable code whose behaviour we cannot
    // determine. Counted separately so the aggregate can say how much of the
    // fleet we simply cannot see into.
    opaqueScripts: report.findings.filter((f) => (f.opaque || []).length).length,
    findingSources: report.findings.map((f) => f.source),
  };
}

const pct = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : 0);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Aggregate into something safe to commit. No store identifiers survive this —
 * counts and distributions only.
 */
export function aggregate(results) {
  const ok = results.filter((r) => r.ok);
  const failed = results.length - ok.length;
  const n = ok.length;

  const hostCounts = new Map();
  for (const r of ok) {
    for (const h of new Set(r.thirdPartyHosts)) hostCounts.set(h, (hostCounts.get(h) || 0) + 1);
  }

  const optimizerCounts = new Map();
  for (const r of ok) {
    for (const o of new Set(r.optimizerHints)) optimizerCounts.set(o, (optimizerCounts.get(o) || 0) + 1);
  }

  const withImages = ok.filter((r) => r.earlyImages.count > 0);

  return {
    scannedAt: new Date().toISOString(),
    // Stated up front because it is the single most important caveat: this is
    // NOT a random sample of Shopify. It is stores that hired us or installed
    // our app, which skews the population in ways we cannot quantify.
    population:
      'Fixel Pixel app-pool stores. NOT a random sample of Shopify — biased toward ' +
      'merchants who sought out tracking/performance help. Prevalence here should ' +
      'not be presented as a Shopify-wide rate.',
    storesAttempted: results.length,
    storesScanned: n,
    storesFailed: failed,
    prevalence: {
      cloakSuspected: { count: ok.filter((r) => r.cloakSuspected).length, pct: pct(ok.filter((r) => r.cloakSuspected).length, n) },
      duplicateBundles: { count: ok.filter((r) => r.duplicateCount > 0).length, pct: pct(ok.filter((r) => r.duplicateCount > 0).length, n) },
      tripleLoadedBundle: { count: ok.filter((r) => r.maxDuplicateLoads >= 3).length, pct: pct(ok.filter((r) => r.maxDuplicateLoads >= 3).length, n) },
      firstImageLazy: {
        count: withImages.filter((r) => r.earlyImages.firstIsLazy).length,
        pct: pct(withImages.filter((r) => r.earlyImages.firstIsLazy).length, withImages.length),
        denominator: withImages.length,
      },
      anyFetchPriorityHigh: { count: ok.filter((r) => r.earlyImages.anyFetchPriority).length, pct: pct(ok.filter((r) => r.earlyImages.anyFetchPriority).length, n) },
      thirdPartyOptimizerInstalled: { count: ok.filter((r) => r.optimizerHints.length).length, pct: pct(ok.filter((r) => r.optimizerHints.length).length, n) },
      // `|| 0` keeps raw files from scans that predate this field aggregatable.
      opaqueScripts: { count: ok.filter((r) => (r.opaqueScripts || 0) > 0).length, pct: pct(ok.filter((r) => (r.opaqueScripts || 0) > 0).length, n) },
    },
    scripts: {
      externalMedian: median(ok.map((r) => r.scripts.external)),
      externalMax: Math.max(0, ...ok.map((r) => r.scripts.external)),
      renderBlockingMedian: median(ok.map((r) => r.scripts.renderBlocking)),
      thirdPartyHostsMedian: median(ok.map((r) => r.thirdPartyHosts.length)),
    },
    topThirdPartyHosts: [...hostCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([host, stores]) => ({ host, stores, pct: pct(stores, n) })),
    optimizerHints: [...optimizerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, stores]) => ({ label, stores, pct: pct(stores, n) })),
  };
}

export function formatFleet(summary) {
  const L = [];
  const row = (label, v) => L.push(`    ${label.padEnd(34)} ${String(v.count).padStart(4)}  ${String(v.pct).padStart(5)}%`);

  L.push(`\n${'═'.repeat(72)}`);
  L.push(`FLEET SCAN — ${summary.storesScanned}/${summary.storesAttempted} stores scanned` + (summary.storesFailed ? ` (${summary.storesFailed} unreachable)` : ''));
  L.push(`${'═'.repeat(72)}`);
  L.push(`⚠ ${summary.population}\n`);

  L.push(`▸ PREVALENCE`);
  row('benchmark cloak suspected', summary.prevalence.cloakSuspected);
  row('duplicate bundle loads', summary.prevalence.duplicateBundles);
  row('  ...loaded 3x or more', summary.prevalence.tripleLoadedBundle);
  row('first image lazy-loaded', summary.prevalence.firstImageLazy);
  L.push(`      (of ${summary.prevalence.firstImageLazy.denominator} stores where images were found)`);
  row('any fetchpriority=high', summary.prevalence.anyFetchPriorityHigh);
  row('3rd-party "optimizer" detected', summary.prevalence.thirdPartyOptimizerInstalled);
  row('OPAQUE (unreadable) scripts', summary.prevalence.opaqueScripts);
  L.push(`      (opaque ≠ cloak: behaviour we cannot read, reported separately from the cloak verdict)`);

  L.push(`\n▸ SCRIPTS (median)`);
  L.push(`    external ${summary.scripts.externalMedian}   render-blocking ${summary.scripts.renderBlockingMedian}   3rd-party hosts ${summary.scripts.thirdPartyHostsMedian}   (max external ${summary.scripts.externalMax})`);

  if (summary.optimizerHints.length) {
    L.push(`\n▸ THIRD-PARTY OPTIMIZERS FOUND`);
    for (const o of summary.optimizerHints) L.push(`    ${o.label.padEnd(34)} ${String(o.stores).padStart(4)}  ${o.pct}%`);
  }

  L.push(`\n▸ MOST COMMON THIRD-PARTY HOSTS`);
  for (const h of summary.topThirdPartyHosts.slice(0, 15)) {
    L.push(`    ${h.host.slice(0, 44).padEnd(46)} ${String(h.stores).padStart(4)}  ${h.pct}%`);
  }
  return L.join('\n');
}
