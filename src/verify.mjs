// verify — the pre-publish gate.
//
// WHY THIS EXISTS. The pipeline had before → optimize → after → compare, and
// every one of those stages measures SPEED. Nothing measured whether the
// optimized theme still WORKS. On example-seafood (2026-08-04) three separate
// regressions shipped into a candidate theme while PageSpeed sat at 79-87 the
// whole time: the homepage rendered no base.css at all, product-card star
// ratings vanished, and the free-gift app was effectively uninstalled. A green
// score is not evidence the storefront is intact, and the client is the one who
// notices.
//
// Every check here is deterministic and reproduces a defect we actually shipped.
// No LLM, no judgement calls — this either fails or it does not, in seconds.
//
// Exit contract: FAIL blocks a publish, WARN is reported and does not.

import { listAssets, getAsset } from './admin.mjs';
import { resilientFetch } from './net.mjs';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** Shopify's `inline_asset_content` refuses anything larger and emits an HTML comment instead. */
export const INLINE_ASSET_CAP = 15360;

/**
 * Fetch a storefront URL under a specific theme.
 *
 * Shopify's preview works by setting a cookie and redirecting, and Node's fetch
 * drops Set-Cookie across a redirect chain. Following redirects automatically
 * therefore returns the LIVE theme while looking like it worked — which is a
 * quiet way to compare a theme against itself and declare everything fine.
 */
async function fetchPreview(storefront, themeId, urlPath = '/', { timeoutMs = 30000 } = {}) {
  const jar = new Map();
  const sep = urlPath.includes('?') ? '&' : '?';
  let url = `${storefront}${urlPath}${sep}preview_theme_id=${themeId}`;

  for (let hop = 0; hop < 8; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await resilientFetch(url, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': MOBILE_UA,
          Accept: 'text/html,application/xhtml+xml',
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        },
      });
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, status: 0, body: '', error: String(err?.message || err) };
    }
    clearTimeout(timer);

    for (const raw of res.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, status: res.status, body: '', error: 'redirect without location' };
      url = new URL(loc, url).toString();
      continue;
    }
    const body = await res.text();
    return { ok: res.status === 200, status: res.status, body, url };
  }
  return { ok: false, status: 0, body: '', error: 'too many redirects' };
}

export function parseBlocks(settingsJson) {
  try {
    const parsed = JSON.parse(settingsJson);
    const blocks = parsed?.current?.blocks || {};
    const out = new Map();
    for (const block of Object.values(blocks)) {
      if (!block?.type) continue;
      out.set(block.type, block.disabled === true);
    }
    return out;
  } catch {
    return null;
  }
}

function appName(blockType) {
  const m = /shopify:\/\/apps\/([^/]+)\/blocks\/([^/]+)/.exec(blockType);
  return m ? `${m[1]} → ${m[2]}` : blockType;
}

/**
 * Disabling an app embed is the cheapest way to buy a PageSpeed point and the
 * most invisible way to remove something the merchant pays for. On example it
 * silently uninstalled the review widget and the free-gift app; no runtime fix
 * could have restored them because the setting, not the code, was the cause.
 */
async function checkAppEmbeds(store, candidateThemeId, liveThemeId) {
  const key = 'config/settings_data.json';
  const [cand, live] = await Promise.all([
    getAsset(store, candidateThemeId, key).catch(() => null),
    getAsset(store, liveThemeId, key).catch(() => null),
  ]);
  if (!cand?.value || !live?.value) {
    return { id: 'app-embeds', level: 'WARN', title: 'App embeds not comparable', detail: 'settings_data.json unreadable on one of the themes' };
  }
  const candBlocks = parseBlocks(cand.value);
  const liveBlocks = parseBlocks(live.value);
  if (!candBlocks || !liveBlocks) {
    return { id: 'app-embeds', level: 'WARN', title: 'App embeds not comparable', detail: 'settings_data.json is not valid JSON' };
  }

  const turnedOff = [];
  for (const [type, liveDisabled] of liveBlocks) {
    if (liveDisabled) continue; // already off on live — not a regression
    const candDisabled = candBlocks.get(type);
    if (candDisabled === true) turnedOff.push(appName(type));
    else if (candDisabled === undefined) turnedOff.push(`${appName(type)} (block absent)`);
  }

  if (turnedOff.length) {
    return {
      id: 'app-embeds',
      level: 'FAIL',
      title: `${turnedOff.length} app embed(s) enabled on live but OFF in the candidate`,
      detail: turnedOff.join('; '),
      why: 'The merchant pays for these. A disabled embed removes the feature entirely and no amount of theme code can bring it back.',
    };
  }
  return { id: 'app-embeds', level: 'PASS', title: 'App embeds match live' };
}

/**
 * `inline_asset_content` silently refuses assets over 15360 bytes and emits an
 * HTML comment instead of the CSS. Inside a <style> tag that is a CDO/CDC token
 * pair — legal CSS that parses to nothing. No console error, no 404, no Liquid
 * error. The stylesheet just does not exist on the page.
 *
 * Checked statically as well as in the render, because the static form names the
 * exact file and line while the rendered form only proves something is wrong.
 */
async function checkInlineAssetCap(store, candidateThemeId) {
  const assets = await listAssets(store, candidateThemeId);
  const sizeOf = new Map(assets.map((a) => [a.key.replace(/^assets\//, ''), a.size || 0]));
  const liquid = assets.filter((a) => /\.liquid$/i.test(a.key));

  const offenders = [];
  // Bounded concurrency: a theme is ~200 liquid files and the Admin API is rate limited.
  for (let i = 0; i < liquid.length; i += 6) {
    const batch = liquid.slice(i, i + 6);
    const loaded = await Promise.all(batch.map((a) => getAsset(store, candidateThemeId, a.key).catch(() => null)));
    for (const asset of loaded) {
      if (!asset?.value) continue;
      const re = /['"]([^'"]+\.(?:css|js))['"]\s*\|\s*inline_asset_content/g;
      let m;
      while ((m = re.exec(asset.value))) {
        const size = sizeOf.get(m[1]);
        if (size && size > INLINE_ASSET_CAP) {
          offenders.push({ file: asset.key, asset: m[1], size });
        }
      }
    }
  }

  if (offenders.length) {
    return {
      id: 'inline-asset-cap',
      level: 'FAIL',
      title: `${offenders.length} asset(s) inlined above Shopify's ${INLINE_ASSET_CAP}-byte cap`,
      detail: offenders.map((o) => `${o.file} inlines ${o.asset} (${o.size} bytes)`).join('; '),
      why: 'Shopify emits an HTML comment instead of the file. Inside <style> that parses to nothing, so the CSS is simply absent — with no error anywhere. Render it through a Liquid snippet instead; snippets have no size cap.',
    };
  }
  return { id: 'inline-asset-cap', level: 'PASS', title: 'No oversized inline_asset_content' };
}

const CAP_MARKER = 'Asset size is too large';

function styleBytes(html) {
  let total = 0;
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) total += m[1].length;
  return total;
}

function themeStylesheetCount(html) {
  return (html.match(/<link[^>]+rel=["']?stylesheet[^>]*>/gi) || []).filter((tag) =>
    /\/cdn\/shop\/t\//.test(tag)
  ).length;
}

/**
 * A raw-original srcset candidate. Dawn-derived card snippets close every
 * srcset with the un-resized source image, so a 250px-wide product card offers
 * the browser a multi-megabyte file and Lighthouse's device takes it. On example
 * this alone was 8.94 MB of a 8.94 MB page.
 */
export function rawOriginalCandidates(html) {
  const out = [];
  const re = /(\/cdn\/shop\/[^\s"']+\?v=\d+)\s+(\d{4,})w/g;
  let m;
  while ((m = re.exec(html))) {
    if (/[?&]width=/.test(m[1])) continue;
    out.push({ url: m[1], width: Number(m[2]) });
  }
  return out;
}

export function renderChecks(candidate, live, urlPath) {
  const checks = [];
  const tag = urlPath === '/' ? 'home' : urlPath;

  if (candidate.body.includes(CAP_MARKER)) {
    checks.push({
      id: `render-inline-cap:${tag}`,
      level: 'FAIL',
      title: `${tag}: Shopify refused an inline asset in the rendered page`,
      detail: CAP_MARKER,
      why: 'The stylesheet is absent from the page even though the <style> tag is present. Check the LENGTH of the inline block, never its presence.',
    });
  }

  const liquidErrors = (candidate.body.match(/Liquid error/g) || []).length;
  if (liquidErrors) {
    checks.push({
      id: `liquid-errors:${tag}`,
      level: 'FAIL',
      title: `${tag}: ${liquidErrors} Liquid error(s) in the rendered page`,
    });
  }

  // Theme CSS delivery parity. Counting <link> tags alone is misleading when a
  // theme inlines on purpose, so inline <style> bytes are counted too and the
  // two are judged together.
  const candCss = styleBytes(candidate.body);
  const liveCss = styleBytes(live.body);
  const candLinks = themeStylesheetCount(candidate.body);
  const liveLinks = themeStylesheetCount(live.body);
  const lostInline = liveCss - candCss;
  const lostLinks = liveLinks - candLinks;
  if (lostLinks > 0 && lostInline > 0) {
    checks.push({
      id: `css-delivery:${tag}`,
      level: 'FAIL',
      title: `${tag}: theme CSS shrank on BOTH paths`,
      detail: `inline ${liveCss} → ${candCss} bytes, theme <link> ${liveLinks} → ${candLinks}`,
      why: 'Deferring app CSS is the goal; losing theme CSS on both the inline and the linked path at once means rules are simply gone.',
    });
  } else if (lostInline > 20000) {
    checks.push({
      id: `css-inline-drop:${tag}`,
      level: 'WARN',
      title: `${tag}: ${lostInline} fewer bytes of inline CSS than live`,
      detail: `inline ${liveCss} → ${candCss} bytes (theme <link> ${liveLinks} → ${candLinks})`,
    });
  }

  const raw = rawOriginalCandidates(candidate.body);
  if (raw.length) {
    const worst = raw.reduce((a, b) => (b.width > a.width ? b : a));
    checks.push({
      id: `srcset-raw-original:${tag}`,
      level: 'WARN',
      title: `${tag}: ${raw.length} srcset candidate(s) offer the un-resized original`,
      detail: `widest ${worst.width}px — ${worst.url}`,
      why: 'Cap the candidate (e.g. width: 1500) in the card snippets. Leave product-media.liquid alone; the gallery needs the full size for zoom.',
    });
  }

  return checks;
}

export async function verifyCandidate(
  store,
  { storefront, candidateThemeId, liveThemeId, urls = ['/'] } = {}
) {
  const base = storefront.replace(/\/$/, '');
  const checks = [];

  const [embeds, inlineCap] = await Promise.all([
    checkAppEmbeds(store, candidateThemeId, liveThemeId),
    checkInlineAssetCap(store, candidateThemeId),
  ]);
  checks.push(embeds, inlineCap);

  for (const urlPath of urls) {
    const [candidate, live] = await Promise.all([
      fetchPreview(base, candidateThemeId, urlPath),
      fetchPreview(base, liveThemeId, urlPath),
    ]);
    const tag = urlPath === '/' ? 'home' : urlPath;
    if (!candidate.ok || !live.ok) {
      checks.push({
        id: `fetch:${tag}`,
        level: 'WARN',
        title: `${tag}: could not render both themes`,
        detail: `candidate ${candidate.status}${candidate.error ? ` (${candidate.error})` : ''}, live ${live.status}${live.error ? ` (${live.error})` : ''}`,
      });
      continue;
    }
    checks.push(...renderChecks(candidate, live, urlPath));
  }

  const failed = checks.filter((c) => c.level === 'FAIL');
  return {
    shop: store.shop,
    candidateThemeId,
    liveThemeId,
    urls,
    checks,
    verdict: failed.length ? 'BLOCK' : 'CLEAR',
    failures: failed.length,
  };
}

export function formatVerify(result) {
  const lines = [];
  lines.push('');
  lines.push(`Pre-publish gate — ${result.shop}`);
  lines.push(`  candidate ${result.candidateThemeId}  vs  live ${result.liveThemeId}`);
  lines.push('');

  const icon = { PASS: '  ok  ', WARN: ' warn ', FAIL: ' FAIL ' };
  for (const c of result.checks) {
    lines.push(`[${icon[c.level] || c.level}] ${c.title}`);
    if (c.detail) lines.push(`         ${c.detail}`);
    if (c.why) lines.push(`         why: ${c.why}`);
  }

  lines.push('');
  lines.push(
    result.verdict === 'BLOCK'
      ? `BLOCK — ${result.failures} check(s) failed. Do not publish.`
      : 'CLEAR — no blocking regression found.'
  );
  lines.push(
    '  This gate proves the storefront is intact, not that it is fast. Speed is what compare/report measure.'
  );
  lines.push('');
  return lines.join('\n');
}
