// Shopify Admin REST client, scoped to what speed work actually needs:
// read the live theme, snapshot it, patch an asset, put it back.
//
// House rule baked in: putAsset REFUSES to write until a backup of that exact
// asset exists on disk. On the Luna engagement the byte-exact backup was the
// only reason a live-theme edit was safe to make at all.

import fs from 'node:fs';
import path from 'node:path';

export const API_VERSION = process.env.SPEEDKIT_API_VERSION || '2025-01';

// Shopify REST allows ~2 req/s on standard plans. Serialize with a small gap
// rather than firing bursts that come back as 429s mid-snapshot.
let chain = Promise.resolve();
function throttled(fn) {
  const next = chain.then(async () => {
    const out = await fn();
    await new Promise((r) => setTimeout(r, 550));
    return out;
  });
  chain = next.catch(() => {});
  return next;
}

export async function adminFetch(store, endpoint, options = {}) {
  if (!store?.accessToken) {
    throw new Error(`No admin token for ${store?.shop || 'store'} — run: speedkit auth (or set SPEEDKIT_TOKEN)`);
  }
  const url = `https://${store.shop}/admin/api/${API_VERSION}/${endpoint.replace(/^\//, '')}`;
  return throttled(async () => {
    const res = await fetch(url, {
      ...options,
      headers: {
        'X-Shopify-Access-Token': store.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const detail = body?.errors ? JSON.stringify(body.errors) : text.slice(0, 300);
      throw new Error(`Admin API ${res.status} on ${endpoint}: ${detail}`);
    }
    return body;
  });
}

export async function getShopInfo(store) {
  const { shop } = await adminFetch(store, 'shop.json');
  return shop;
}

/** The published (live) theme — the only one a speed engagement should touch. */
export async function getLiveTheme(store) {
  const { themes } = await adminFetch(store, 'themes.json');
  const live = themes.find((t) => t.role === 'main');
  if (!live) throw new Error('No published theme found');
  return live;
}

export async function listThemes(store) {
  const { themes } = await adminFetch(store, 'themes.json');
  return themes;
}

export async function listAssets(store, themeId) {
  const { assets } = await adminFetch(store, `themes/${themeId}/assets.json`);
  return assets;
}

export async function getAsset(store, themeId, key) {
  const { asset } = await adminFetch(
    store,
    `themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`
  );
  return asset;
}

/**
 * Snapshot the theme's source files to disk. Skips binary assets (images,
 * fonts) — speed work edits liquid/js/css/json, and pulling megabytes of
 * images just makes the snapshot slow and the diff noisy.
 */
const TEXT_ASSET = /\.(liquid|json|js|css|scss|txt|svg)$/i;

export async function snapshotTheme(store, themeId, destDir, { onProgress } = {}) {
  const assets = await listAssets(store, themeId);
  const targets = assets.filter((a) => TEXT_ASSET.test(a.key));
  fs.mkdirSync(destDir, { recursive: true });
  let done = 0;
  const written = [];
  for (const meta of targets) {
    const asset = await getAsset(store, themeId, meta.key);
    const body = asset.value ?? '';
    const file = path.join(destDir, meta.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
    written.push(meta.key);
    done += 1;
    onProgress?.(done, targets.length, meta.key);
  }
  return { total: targets.length, written, dir: destDir };
}

/**
 * Write an asset back to the live theme. Refuses unless `backupPath` exists —
 * a write we cannot undo is a write we do not make.
 */
export async function putAsset(store, themeId, key, value, { backupPath } = {}) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error(
      `Refusing to write ${key}: no backup at ${backupPath || '(none given)'}. ` +
        `Run "speedkit backup <shop>" first — every live edit must be reversible.`
    );
  }
  const res = await adminFetch(store, `themes/${themeId}/assets.json`, {
    method: 'PUT',
    body: JSON.stringify({ asset: { key, value } }),
  });
  return res.asset;
}

/** A real product URL, so PSI measures a page shoppers actually load. */
export async function pickProductUrl(store, shopDomain) {
  try {
    const { products } = await adminFetch(store, 'products.json?limit=5&status=active');
    const handle = products?.[0]?.handle;
    if (handle) return `https://${shopDomain}/products/${handle}`;
  } catch {
    // read_products may not be granted — not fatal, caller falls back to home.
  }
  return null;
}
