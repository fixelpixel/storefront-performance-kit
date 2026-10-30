// End-to-end self-test for the auditor. Serves a fixture storefront on
// localhost that contains BOTH real-world failure modes we ship detectors for,
// then asserts the auditor finds them.
//
//   run: node test/selftest.mjs

import http from 'node:http';
import assert from 'node:assert/strict';
import { auditStorefront, formatAudit } from '../src/audit.mjs';

// A cloak modelled on the one found on Luna & Sophia: gates on a speed-test
// fingerprint, then neutralizes scripts. Base64 is inert here — the auditor
// decodes nothing and executes nothing; it matches on the calling pattern.
const CLOAK_JS = `
!function(){
  if (navigator.platform.indexOf('x86_64') > -1 || /X11|GTmetrix/.test(navigator.userAgent)) {
    window._isPSA = true;
    eval(atob('dmFyIHg9MTs='));
    new MutationObserver(function(m){
      m.forEach(function(r){ r.addedNodes.forEach(function(n){
        if (n.tagName === 'SCRIPT') { n.type = 'text/lazyload'; n.removeAttribute('src'); }
      }); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
}();
`;

const FIXTURE_HTML = `<!doctype html><html><head>
<script src="/cdn/component-3.0.96.js"></script>
<script src="/cdn/app-bundle.js?v=1"></script>
<script src="/cdn/app-bundle.js?v=2"></script>
<script src="/cdn/app-bundle.js?v=3"></script>
<script defer src="/cdn/theme.js"></script>
<script>window.dataLayer=window.dataLayer||[];</script>
</head><body><h1>fixture</h1></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/cdn/component-3.0.96.js')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(CLOAK_JS);
  }
  if (req.url.startsWith('/cdn/')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end('console.log("benign");');
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(FIXTURE_HTML);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const report = await auditStorefront(base);
console.log(formatAudit(report));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

console.log('\n--- assertions ---');
check('page fetched', () => assert.equal(report.ok, true));
check('duplicate bundle detected', () => {
  const dup = report.duplicates.find((d) => d.script.includes('app-bundle.js'));
  assert.ok(dup, 'app-bundle.js duplicate not reported');
  assert.equal(dup.loadedTimes, 3);
});
check('cloak suspected', () => assert.equal(report.cloakSuspected, true));
check('cloak attributed to the right file', () => {
  const f = report.findings.find((x) => x.cloak);
  assert.ok(f, 'no cloak finding');
  assert.ok(f.source.includes('component-3.0.96.js'), `attributed to ${f.source}`);
});
check('test-gate reasons captured', () => {
  const f = report.findings.find((x) => x.cloak);
  const labels = f.gates.map((g) => g.label).join(' | ');
  assert.ok(/x86_64/.test(labels), `gates: ${labels}`);
  assert.ok(/GTmetrix/i.test(labels), `gates: ${labels}`);
});
check('script suppression captured', () => {
  const f = report.findings.find((x) => x.cloak);
  const labels = f.obfuscation.map((o) => o.label).join(' | ');
  assert.ok(/text\/lazyload/.test(labels), `obfuscation: ${labels}`);
  assert.ok(/atob/.test(labels), `obfuscation: ${labels}`);
});
check('render-blocking counted (defer excluded)', () => {
  assert.equal(report.scripts.renderBlocking, 4);
});
check('clean page yields no false positive', async () => {
  assert.ok(true); // covered by the negative fixture below
});

// Negative control: a page with nothing wrong must report nothing wrong.
const clean = http.createServer((req, res) => {
  if (req.url.startsWith('/cdn/')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end('console.log("fine");');
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><head><script defer src="/cdn/a.js"></script></head><body>ok</body></html>');
});
await new Promise((r) => clean.listen(0, '127.0.0.1', r));
const cleanReport = await auditStorefront(`http://127.0.0.1:${clean.address().port}/`);
check('negative control: no cloak flagged', () => assert.equal(cleanReport.cloakSuspected, false));
check('negative control: no duplicates flagged', () => assert.equal(cleanReport.duplicates.length, 0));

server.close();
clean.close();

console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
