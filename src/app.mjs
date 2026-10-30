// Minimal Shopify OAuth app — its ONLY job is to turn "merchant clicks a link"
// into "we hold an offline admin token for that store". No embedded UI, no
// billing, no webhooks. Scopes are deliberately the smallest set that speed
// work needs, so a merchant granting access is granting access to their THEME,
// not to their customers or orders.

import express from 'express';
import crypto from 'node:crypto';
import { saveStore, listStores, normalizeShop } from './store.mjs';

const API_KEY = process.env.SHOPIFY_API_KEY;
const API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = (process.env.SHOPIFY_APP_URL || '').replace(/\/$/, '');
const SCOPES = process.env.SHOPIFY_SCOPES || 'read_themes,write_themes,read_products';
const PORT = Number(process.env.PORT || 3999);

if (!API_KEY || !API_SECRET || !APP_URL) {
  console.error(
    'Missing config. Set SHOPIFY_API_KEY, SHOPIFY_API_SECRET and SHOPIFY_APP_URL\n' +
      '(copy .env.example to .env and fill it in — see README).'
  );
  process.exit(1);
}

const app = express();
const pendingStates = new Map(); // state -> { shop, expires }

function isValidShopDomain(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || '');
}

/** Shopify signs callbacks with HMAC-SHA256 over the sorted query string. */
function verifyHmac(query) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', API_SECRET).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(hmac), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/', (_req, res) => {
  const stores = listStores();
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>Shopify Speed Kit</title>
<style>body{font:15px/1.6 system-ui;margin:40px auto;max-width:640px;color:#14181e}
code{background:#eef1f4;padding:2px 6px;border-radius:4px}
li{margin:6px 0}</style>
<h1>Shopify Speed Kit</h1>
<p>Connected stores: <strong>${stores.length}</strong></p>
<ul>${stores.map((s) => `<li><code>${s.shop}</code> — ${s.installedAt || 'installed'}</li>`).join('') || '<li>none yet</li>'}</ul>
<p>To connect a store, open:<br><code>${APP_URL}/install?shop=example.myshopify.com</code></p>
<p>Scopes requested: <code>${SCOPES}</code></p>`);
});

app.get('/install', (req, res) => {
  const shop = normalizeShop(req.query.shop);
  if (!isValidShopDomain(shop)) {
    return res.status(400).send('Pass ?shop=example.myshopify.com');
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { shop, expires: Date.now() + 10 * 60 * 1000 });
  const url =
    `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(API_KEY)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(`${APP_URL}/auth/callback`)}` +
    `&state=${state}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const shop = normalizeShop(req.query.shop);

  if (!isValidShopDomain(shop)) return res.status(400).send('Invalid shop domain');
  if (!verifyHmac(req.query)) return res.status(401).send('HMAC verification failed');

  const pending = pendingStates.get(String(state));
  pendingStates.delete(String(state));
  if (!pending || pending.shop !== shop || pending.expires < Date.now()) {
    return res.status(401).send('Invalid or expired state — start again from /install');
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: API_KEY, client_secret: API_SECRET, code }),
    });
    if (!tokenRes.ok) {
      return res.status(502).send(`Token exchange failed: HTTP ${tokenRes.status}`);
    }
    const data = await tokenRes.json();
    saveStore(shop, {
      accessToken: data.access_token,
      scope: data.scope,
      installedAt: new Date().toISOString(),
    });
    console.log(`[speed-kit] connected ${shop} (scope: ${data.scope})`);
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;margin:60px auto;max-width:560px}</style>` +
        `<h2>✅ ${shop} connected</h2><p>Speed Kit now has theme access. You can close this tab.</p>` +
        `<p style="color:#666">Next: <code>speedkit audit ${shop}</code></p>`
    );
  } catch (err) {
    res.status(500).send(`Install failed: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`[speed-kit] auth server on http://localhost:${PORT}`);
  console.log(`[speed-kit] public URL: ${APP_URL}`);
  console.log(`[speed-kit] install link: ${APP_URL}/install?shop=example.myshopify.com`);
});
