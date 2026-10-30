// net — fetch that survives a broken local resolver.
//
// WHY. This machine's router resolves storefront hostnames to addresses that do
// not answer (it maps *.myshopify.com to a private 10.x address, and has been
// seen failing outright on custom domains too). Every tool in the kit then dies
// with ENOTFOUND / EAI_AGAIN and the failure reads like "the site is down"
// rather than "this laptop cannot look it up". That misreading has cost real
// time more than once.
//
// So: try the OS resolver first, and only on a *resolution* failure fall back to
// DNS-over-HTTPS and connect by IP. Google's DoH endpoint is addressed by its
// literal IP — asking DNS where the DNS server lives is exactly the loop we are
// trying to escape — and 8.8.8.8 is on the dns.google certificate, so TLS still
// verifies normally.
//
// The fallback is deliberately built on node:https rather than a dispatcher:
// undici is not importable as a bare specifier, and adding a dependency to work
// around one laptop's DNS is a bad trade. The adapter below exposes only the
// handful of Response members the kit actually uses.

import https from 'node:https';

const cache = new Map();

function isResolutionError(err) {
  const code = err?.cause?.code || err?.code || '';
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

/** A -> first IPv4, via DoH addressed by IP so it cannot itself need DNS. */
export async function resolveViaDoh(hostname, { timeoutMs = 8000 } = {}) {
  if (cache.has(hostname)) return cache.get(hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://8.8.8.8/resolve?name=${encodeURIComponent(hostname)}&type=A`, {
      signal: ctrl.signal,
      headers: { accept: 'application/dns-json', host: 'dns.google' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const answer = (body.Answer || []).find((a) => a.type === 1 && a.data);
    const ip = answer?.data || null;
    if (ip) cache.set(hostname, ip);
    return ip;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal stand-in for the parts of Response the kit reads. */
function toResponseLike(res, body) {
  const headers = {
    get: (name) => {
      const v = res.headers[String(name).toLowerCase()];
      return Array.isArray(v) ? v[0] : v ?? null;
    },
    getSetCookie: () => {
      const v = res.headers['set-cookie'];
      return Array.isArray(v) ? v : v ? [v] : [];
    },
  };
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    headers,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/**
 * Connect to `ip` while keeping the real hostname for SNI and certificate
 * validation — this is a DNS workaround, not a TLS one. `redirect: 'manual'`
 * semantics are the only mode used here; redirects are returned, never followed.
 */
function requestByIp(url, ip, init) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: ip,
        servername: u.hostname, // SNI + cert check against the real name
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method || 'GET',
        headers: { host: u.hostname, ...(init.headers || {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(toResponseLike(res, Buffer.concat(chunks).toString('utf8'))));
      }
    );
    req.on('error', reject);
    if (init.signal) init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * fetch with a DoH fallback. Same signature as global fetch; the fallback is
 * invisible unless the local resolver has already failed.
 */
export async function resilientFetch(url, init = {}) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isResolutionError(err)) throw err;
    const { hostname } = new URL(url);
    const ip = await resolveViaDoh(hostname);
    if (!ip) throw err;
    return requestByIp(url, ip, init);
  }
}
