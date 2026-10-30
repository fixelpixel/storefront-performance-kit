// Synthetic regression fixtures for storefront verification.

import assert from 'node:assert/strict';
import { renderChecks, rawOriginalCandidates, parseBlocks, INLINE_ASSET_CAP } from '../src/verify.mjs';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}
const page = (body) => ({ ok: true, status: 200, body });
const idsOf = (checks) => checks.map((c) => c.id.split(':')[0]);
const levelOf = (checks, id) => checks.find((c) => c.id.startsWith(id))?.level;

console.log('\nverify — pre-publish gate\n');

// ---------------------------------------------------------------- inline cap
{
  // What Shopify actually emits when the asset exceeds 15360 bytes: a comment,
  // inside the <style> tag, which parses to nothing.
  const broken = page(
    '<html><head><style data-base><!-- Asset size is too large. This leads to poor ' +
      'performance on the storefront. Size limit: 15360 bytes. --></style></head><body></body></html>'
  );
  const live = page('<html><head><style data-base>' + 'a{color:red}'.repeat(2000) + '</style></head><body></body></html>');
  const checks = renderChecks(broken, live, '/');
  assert.equal(levelOf(checks, 'render-inline-cap'), 'FAIL');
  ok('rendered inline-asset cap refusal FAILS');

  const healthy = page('<html><head><style data-base>' + 'a{color:red}'.repeat(2000) + '</style></head><body></body></html>');
  assert.equal(levelOf(renderChecks(healthy, live, '/'), 'render-inline-cap'), undefined);
  ok('negative control: a real inline stylesheet does not fail');
}

// ------------------------------------------------------------- liquid errors
{
  const checks = renderChecks(page('<p>Liquid error: undefined method</p>'), page('<p>fine</p>'), '/');
  assert.equal(levelOf(checks, 'liquid-errors'), 'FAIL');
  ok('Liquid errors in the render FAIL');

  assert.equal(levelOf(renderChecks(page('<p>fine</p>'), page('<p>fine</p>'), '/'), 'liquid-errors'), undefined);
  ok('negative control: a clean page reports no Liquid errors');
}

// -------------------------------------------------------------- css delivery
{
  const cssLink = '<link rel="stylesheet" href="/cdn/shop/t/2/assets/base.css">';
  const live = page(`<head>${cssLink}${cssLink}<style>${'x{a:b}'.repeat(6000)}</style></head>`);

  // The synthetic CSS fixture: the linked stylesheet was dropped AND the inline block
  // that was supposed to replace it is empty. Losing both paths at once is the
  // signal; losing one is a legitimate optimization.
  const bothLost = page('<head><style>tiny{}</style></head>');
  assert.equal(levelOf(renderChecks(bothLost, live, '/'), 'css-delivery'), 'FAIL');
  ok('theme CSS lost on BOTH the inline and the linked path FAILS');

  // Inlining the theme CSS and dropping the <link> is the intended technique.
  const inlinedOnPurpose = page(`<head><style>${'x{a:b}'.repeat(6000)}</style></head>`);
  assert.notEqual(levelOf(renderChecks(inlinedOnPurpose, live, '/'), 'css-delivery'), 'FAIL');
  ok('negative control: inlining instead of linking is not a failure');
}

// ------------------------------------------------------------------- srcset
{
  const raw =
    '<img srcset="/cdn/shop/files/a.jpg?v=1&width=533 533w,' +
    '/cdn/shop/files/a.jpg?v=1&width=1066 1066w,' +
    '/cdn/shop/files/a.jpg?v=1 3644w">';
  const found = rawOriginalCandidates(raw);
  assert.equal(found.length, 1);
  assert.equal(found[0].width, 3644);
  ok('an un-resized srcset candidate is detected by its missing width param');

  const capped =
    '<img srcset="/cdn/shop/files/a.jpg?v=1&width=533 533w,/cdn/shop/files/a.jpg?v=1&width=1500 1500w">';
  assert.equal(rawOriginalCandidates(capped).length, 0);
  ok('negative control: a capped srcset reports nothing');

  // It must WARN, never BLOCK: the rendering is pixel-identical, only bytes change.
  const checks = renderChecks(page(raw), page(raw), '/');
  assert.equal(levelOf(checks, 'srcset-raw-original'), 'WARN');
  ok('raw originals warn rather than block (rendering is unaffected)');
}

// -------------------------------------------------------------- app embeds
{
  const settings = (disabled) =>
    JSON.stringify({ current: { blocks: { a: { type: 'shopify://apps/judge-me-reviews/blocks/judgeme_core/x', disabled } } } });
  assert.equal(parseBlocks(settings(true)).values().next().value, true);
  assert.equal(parseBlocks(settings(false)).values().next().value, false);
  ok('app-embed disabled flags parse from settings_data.json');

  assert.equal(parseBlocks('{not json'), null);
  ok('negative control: unparseable settings yield null, not a false PASS');
}

// ----------------------------------------------------------------- constants
{
  assert.equal(INLINE_ASSET_CAP, 15360);
  ok('the inline-asset cap matches the platform limit');
}

console.log(`\n${passed} checks passed\n`);
