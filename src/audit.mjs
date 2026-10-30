// Storefront auditor. Runs against the PUBLIC page — no admin access needed,
// so it works on a prospect's store before anything is installed.
//
// It looks for the two failure modes we have actually been burned by:
//
//   1. Benchmark cloaking (Luna & Sophia, 2026-07). A script that strips or
//      defers other scripts ONLY when it detects a speed-test environment
//      (Linux/x86_64, GTmetrix, Lighthouse). Real shoppers get the heavy page;
//      the audit tool gets a fake score. Scores built on it are fiction.
//
//   2. Duplicate script loads (example Seafood, 2026-07). The same app bundle
//      pulled 2-3x on one page — hundreds of KB of near-100%-unused JS that no
//      amount of image work will fix.
//
// Findings are reported with what was matched and where. We do not execute any
// payload we find; obfuscated blocks are decoded as STRINGS only.

const CLOAK_GATES = [
  { pattern: /x86_64/i, label: 'navigator.platform contains "x86_64" (Linux bots / PSI runners)' },
  { pattern: /GTmetrix/i, label: 'user-agent contains "GTmetrix"' },
  { pattern: /\bX11\b/, label: 'user-agent contains "X11" (Linux UA)' },
  { pattern: /Lighthouse/i, label: 'user-agent contains "Lighthouse"' },
  { pattern: /PageSpeed|Page Speed/i, label: 'user-agent contains "PageSpeed"' },
  { pattern: /HeadlessChrome/i, label: 'user-agent contains "HeadlessChrome"' },
  { pattern: /navigator\.webdriver/i, label: 'checks navigator.webdriver (automation flag)' },
];

const OBFUSCATION = [
  { pattern: /eval\s*\(\s*atob\s*\(/i, label: 'eval(atob(...)) — base64 payload executed' },
  { pattern: /eval\s*\(\s*decodeURIComponent\s*\(/i, label: 'eval(decodeURIComponent(...))' },
  { pattern: /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e/i, label: 'Dean Edwards packer' },
  { pattern: /Function\s*\(\s*atob\s*\(/i, label: 'Function(atob(...))' },
];

/**
 * Opaque obfuscation: code whose behaviour cannot be determined by reading it.
 *
 * This is reported SEPARATELY from the cloak verdict and never sets `cloak` on
 * its own — obfuscation is suspicious, not proof. But it belongs in a client
 * report, because a vendor shipping code you cannot audit onto your storefront
 * is a decision the merchant should be making knowingly.
 *
 * Added after a fleet scan found a "performance" vendor on 6 client stores
 * shipping a custom multi-layer obfuscator (character-shuffling decoder +
 * dynamic `constructor` lookup to reach Function()). None of the eval/atob/
 * packer rules matched it. Legitimate performance tooling — Shopify's own
 * perf-kit included — ships readable minified code.
 */
const OPAQUE = [
  {
    // A long run of apparent gibberish: no spaces, mixed case+digits, far
    // longer than any real identifier or URL.
    test: (s) => /['"][A-Za-z0-9+/=$_.!%,;:(){}\[\]\\-]{600,}['"]/.test(s),
    label: 'very long encoded string literal (contents not readable)',
  },
  {
    // Index-shuffling decoders: arithmetic on char positions then join('').
    test: (s) => /charAt\s*\([^)]*\)/.test(s) && /%\s*\w+\s*;/.test(s) && /join\s*\(\s*['"]{2}\s*\)|join\s*\(\s*''\s*\)/.test(s),
    label: 'character-shuffling decoder (string is unscrambled at runtime)',
  },
  {
    // Reaching Function() without naming it, the classic eval-equivalent.
    test: (s) => /\[\s*['"]constructor['"]\s*\]/.test(s) || /\w+\s*\[\s*\w+\s*\]\s*\(\s*\w*\s*,\s*\w+\s*\(/.test(s) && /substr\s*\(\s*0\s*,/.test(s),
    label: 'dynamic constructor lookup (builds a function from a string)',
  },
];

function scanOpaque(source) {
  return OPAQUE.filter((r) => {
    try {
      return r.test(source);
    } catch {
      return false;
    }
  }).map((r) => ({ label: r.label, matched: '(structural match)' }));
}

const SUPPRESSION = [
  { pattern: /text\/lazyload/i, label: 'rewrites scripts to type="text/lazyload" (script suppression)' },
  { pattern: /removeAttribute\s*\(\s*['"]src['"]\s*\)/i, label: 'strips src from script tags' },
  { pattern: /type\s*=\s*['"]text\/(plain|dummy|blocked)['"]/i, label: 'neutralizes scripts via fake type' },
];

// Shopify's OWN platform code legitimately fingerprints automation: Shopify Pay
// checks HeadlessChrome for bot protection, and shopify-perf-kit checks
// navigator.webdriver so it can exclude synthetic traffic from the merchant's
// RUM. Flagging those is a false positive on every Shopify store on earth, so
// first-party platform paths are exempt from the GATE rules.
//
// Deliberately narrow: only Shopify-served platform bundles. A cloak hiding in
// /cdn/shop/files/ (merchant-uploaded assets) must still be caught.
const FIRST_PARTY_PLATFORM = [
  /\/cdn\/shopifycloud\//i,
  /shopify-perf-kit[-.]/i,
  /\/cdn\/wpm\//i,
  /cdn\.shopify\.com\/shopifycloud\//i,
];

function isFirstPartyPlatform(url) {
  return typeof url === 'string' && FIRST_PARTY_PLATFORM.some((re) => re.test(url));
}

function scan(source, rules) {
  const hits = [];
  for (const rule of rules) {
    const m = source.match(rule.pattern);
    if (m) hits.push({ label: rule.label, matched: m[0].slice(0, 80) });
  }
  return hits;
}

/** Strip cache-busting/version query so the same bundle collapses to one key. */
function scriptIdentity(url) {
  try {
    const u = new URL(url, 'https://example.com');
    return u.origin === 'https://example.com' ? u.pathname : u.origin + u.pathname;
  } catch {
    return url;
  }
}

export async function fetchText(url, { timeoutMs = 20000, ua } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          ua ||
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: '*/*',
      },
      redirect: 'follow',
    });
    return { ok: res.ok, status: res.status, body: await res.text(), url: res.url };
  } catch (err) {
    return { ok: false, status: 0, body: '', url, error: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

function extractScripts(html, pageUrl) {
  const external = [];
  const inline = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) {
      let abs = src;
      try {
        abs = new URL(src, pageUrl).href;
      } catch {
        /* keep raw */
      }
      external.push({
        url: abs,
        async: /\basync\b/i.test(attrs),
        defer: /\bdefer\b/i.test(attrs),
        blocking: !/\basync\b|\bdefer\b/i.test(attrs),
      });
    } else if (body.trim()) {
      inline.push(body);
    }
  }
  return { external, inline };
}

/**
 * Audit a storefront URL. Fetches the page, then fetches each same-origin-ish
 * script and scans it. Returns structured findings — the caller decides how
 * loudly to report them.
 */
export async function auditStorefront(pageUrl, { fetchScripts = true, maxScripts = 40 } = {}) {
  const page = await fetchText(pageUrl);
  if (!page.ok) {
    return { url: pageUrl, ok: false, error: page.error || `HTTP ${page.status}`, findings: [] };
  }

  const { external, inline } = extractScripts(page.body, page.url);

  // --- duplicate bundles -------------------------------------------------
  const byIdentity = new Map();
  for (const s of external) {
    const id = scriptIdentity(s.url);
    byIdentity.set(id, (byIdentity.get(id) || 0) + 1);
  }
  const duplicates = [...byIdentity.entries()]
    .filter(([, n]) => n > 1)
    .map(([id, n]) => ({ script: id, loadedTimes: n }))
    .sort((a, b) => b.loadedTimes - a.loadedTimes);

  // --- inline sources ----------------------------------------------------
  const findings = [];
  inline.forEach((code, i) => {
    const hits = [...scan(code, OBFUSCATION), ...scan(code, SUPPRESSION)];
    const gates = scan(code, CLOAK_GATES);
    if (hits.length || gates.length) {
      findings.push({
        source: `inline script #${i + 1}`,
        obfuscation: hits,
        gates,
        cloak: gates.length > 0 && hits.length > 0,
      });
    }
  });

  // --- external sources --------------------------------------------------
  const scanned = [];
  if (fetchScripts) {
    const unique = [...new Set(external.map((s) => s.url))].slice(0, maxScripts);
    for (const url of unique) {
      const js = await fetchText(url);
      if (!js.ok) continue;
      scanned.push({ url, bytes: js.body.length });
      const platform = isFirstPartyPlatform(url);
      const hits = [...scan(js.body, OBFUSCATION), ...scan(js.body, SUPPRESSION)];
      // Opaque code is reported but never proves a cloak on its own.
      const opaque = platform ? [] : scanOpaque(js.body);
      // Shopify's own bundles legitimately fingerprint automation — exempt them
      // from gate matching so we don't flag every store on the platform.
      const gates = platform ? [] : scan(js.body, CLOAK_GATES);
      if (hits.length || gates.length || opaque.length) {
        findings.push({
          source: url,
          bytes: js.body.length,
          firstPartyPlatform: platform,
          obfuscation: hits,
          opaque,
          gates,
          // A cloak needs BOTH: a way to detect the test AND a way to hide work.
          cloak: gates.length > 0 && hits.length > 0,
        });
      }
    }
  }

  const blocking = external.filter((s) => s.blocking);

  return {
    url: page.url,
    ok: true,
    scripts: {
      external: external.length,
      inline: inline.length,
      renderBlocking: blocking.length,
      blockingUrls: blocking.slice(0, 15).map((s) => s.url),
      scanned: scanned.length,
    },
    duplicates,
    findings,
    cloakSuspected: findings.some((f) => f.cloak),
  };
}

export function formatAudit(report) {
  const L = [];
  L.push(`\n=== Storefront audit: ${report.url} ===`);
  if (!report.ok) {
    L.push(`  FAILED: ${report.error}`);
    return L.join('\n');
  }
  const s = report.scripts;
  L.push(`  scripts: ${s.external} external, ${s.inline} inline, ${s.renderBlocking} render-blocking (scanned ${s.scanned})`);

  if (report.duplicates.length) {
    L.push(`\n  ⚠ DUPLICATE SCRIPT LOADS (same bundle pulled more than once):`);
    for (const d of report.duplicates) L.push(`     ${d.loadedTimes}x  ${d.script}`);
  } else {
    L.push(`  ✓ no duplicate script loads IN THE SERVED HTML`);
    L.push(`      (this scan parses the HTML only — bundles injected later by JS are`);
    L.push(`       invisible here. Lighthouse's duplicated-javascript audit sees those.)`);
  }

  if (report.cloakSuspected) {
    L.push(`\n  🚨 BENCHMARK CLOAKING SUSPECTED — the page behaves differently for speed tests.`);
    L.push(`     Any PageSpeed/GTmetrix score for this store is unreliable until removed.`);
  }

  const flagged = report.findings.filter((f) => f.obfuscation.length || f.gates.length);
  if (flagged.length) {
    L.push(`\n  Flagged sources:`);
    for (const f of flagged) {
      L.push(`   • ${f.source}${f.bytes ? ` (${(f.bytes / 1024).toFixed(1)} KB)` : ''}${f.cloak ? '  ← CLOAK' : ''}`);
      for (const o of f.obfuscation) L.push(`       obfuscation: ${o.label}`);
      for (const o of f.opaque || []) L.push(`       opaque:      ${o.label}`);
      for (const g of f.gates) L.push(`       test-gate:   ${g.label}`);
    }
  } else {
    L.push(`  ✓ no obfuscated / test-gated scripts found`);
  }

  const opaqueCount = report.findings.filter((f) => (f.opaque || []).length).length;
  if (opaqueCount) {
    L.push(`\n  ⚠ ${opaqueCount} script(s) are OPAQUE — deliberately unreadable, so what they`);
    L.push(`     do cannot be verified by reading them. Not proof of a cloak, but a vendor`);
    L.push(`     shipping unauditable code to a storefront is a merchant decision.`);
  }
  return L.join('\n');
}
