// Token storage. One JSON file, chmod 600, outside the repo — tokens never
// land in git. A store record is { shop, accessToken, scope, installedAt }.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.SPEEDKIT_HOME || path.join(os.homedir(), '.shopify-speed-kit');
const DB = path.join(HOME, 'stores.json');

export function kitHome() {
  return HOME;
}

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

function readAll() {
  if (!fs.existsSync(DB)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(data) {
  ensureHome();
  fs.writeFileSync(DB, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(DB, 0o600);
}

export function normalizeShop(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return s || null;
}

export function saveStore(shop, record) {
  const key = normalizeShop(shop);
  const all = readAll();
  all[key] = { shop: key, ...record };
  writeAll(all);
  return all[key];
}

/**
 * Resolve a store's admin token. Precedence:
 *   1. SPEEDKIT_TOKEN env (one-off / CI / a token pasted from a custom app)
 *   2. the local store file (written by the OAuth app)
 * Returns null when we genuinely have no access — callers must say so plainly
 * rather than pretending a read failed for another reason.
 */
export function getStore(shop) {
  const key = normalizeShop(shop);
  if (process.env.SPEEDKIT_TOKEN) {
    return { shop: key, accessToken: process.env.SPEEDKIT_TOKEN, source: 'env' };
  }
  const rec = readAll()[key];
  return rec ? { ...rec, source: 'file' } : null;
}

export function listStores() {
  return Object.values(readAll()).map((s) => ({
    shop: s.shop,
    scope: s.scope || null,
    installedAt: s.installedAt || null,
  }));
}

export function removeStore(shop) {
  const key = normalizeShop(shop);
  const all = readAll();
  if (!all[key]) return false;
  delete all[key];
  writeAll(all);
  return true;
}
