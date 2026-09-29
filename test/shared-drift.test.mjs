// Shared top bar drift checks (Release 3).
//
//   pnpm build && pnpm test:site
//
// The two sites draw the same top bar from shared/nav.json + shared/efm-bar.css.
// The portal builds from music/ only, so it keeps byte-for-byte copies under
// music/src/shared/ (node shared/sync.mjs). This fails when:
//   - a portal copy differs from its canonical file;
//   - the portal's colour tokens differ from the site's;
//   - the built info pages render a bar that is not exactly nav.json (every
//     link, label and target, resolved to absolute URLs). The portal's
//     test/ui/site-bar.test.tsx checks its rendered bar against the SAME
//     expected list, so the two bars cannot drift apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SHARED_FILES } from '../shared/sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readRoot = (p) => readFileSync(join(ROOT, p), 'utf8');
const nav = JSON.parse(readRoot('shared/nav.json'));

test('the portal copies of the shared files are byte-identical (node shared/sync.mjs)', () => {
  for (const f of SHARED_FILES) {
    assert.equal(readRoot(`music/src/shared/${f}`), readRoot(`shared/${f}`), `music/src/shared/${f} drifted from shared/${f}`);
  }
});

const tokenDecls = (css) =>
  Object.fromEntries([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--efm-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

test('the portal colour tokens match the site tokens', () => {
  const site = tokenDecls(readRoot('src/styles/tokens.css'));
  const portal = tokenDecls(readRoot('music/src/app/tokens.css'));
  assert.ok(Object.keys(site).length >= 10);
  assert.deepEqual(portal, site);
});

test('the shared bar stylesheet is CEF-safe and only uses the shared tokens', () => {
  const css = readRoot('shared/efm-bar.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /backdrop-filter|filter\s*:/, 'no blur/filter (CEF paints it black)');
  const site = tokenDecls(readRoot('src/styles/tokens.css'));
  for (const [, v] of css.matchAll(/var\((--efm-[\w-]+)\)/g)) assert.ok(v in site, `${v} is not a shared token`);
});

test('nav.json: the approved items, no Discord, no role-specific entries', () => {
  assert.deepEqual(nav.items.map((i) => i.label), ['Listen', 'About', 'Events', 'Stats', 'Music', 'Contact']);
  assert.deepEqual([nav.musicMenu.submit, ...nav.musicMenu.items].map((i) => i.label), ['Submit music', 'My music', 'Library']);
  assert.equal(nav.webPlayer.label, 'Web Player');
  const raw = JSON.stringify({ ...nav, $comment: '' });
  assert.doesNotMatch(raw, /discord/i);
  const links = [nav.brand, ...nav.items, nav.musicMenu.submit, ...nav.musicMenu.items, nav.webPlayer];
  for (const l of links) {
    assert.doesNotMatch(`${l.label} ${l.path ?? ''}`, /\b(review|admin|schedule)\b/i, `${l.label}: staff/role items stay out of the top bar`);
  }
});

// ---- The rendered info bar vs nav.json -------------------------------------

/** Every link in the bar as [text, absolute URL], in document order. */
export function barLinks(headerHtml, base) {
  return [...headerHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => {
    const href = /\shref="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const text = inner.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    return [text, new URL(href.replace(/&amp;/g, '&'), base).href];
  });
}

/** What both sites must render, from nav.json alone. */
function expectedBar() {
  const abs = (l) => new URL(l.path, nav.origins[l.site]).href;
  const row = (l) => [l.desc ? `${l.label} ${l.desc}` : l.label, abs(l)];
  const menu = [nav.musicMenu.submit, ...nav.musicMenu.items].map(row);
  const plain = nav.items.filter((i) => !i.menu);
  return [
    ['Euphoric FM', abs(nav.brand)],
    ...nav.items.flatMap((i) => (i.menu ? menu : [row(i)])),
    row(nav.webPlayer),
    ...[...plain, nav.webPlayer].map(row),
    ...menu,
  ];
}

const dist = (p) => {
  const f = join(ROOT, 'dist', p);
  assert.ok(existsSync(f), `dist/${p} is missing — run \`pnpm build\` first`);
  return readFileSync(f, 'utf8');
};
const header = (html) => {
  const m = /<header class="efmh"[\s\S]*?<\/header>/.exec(html);
  assert.ok(m, 'shared top bar not found');
  return m[0];
};
const PAGES = { 'index.html': 'listen', 'events/index.html': 'events', 'player/index.html': 'player' };

test('every info page renders exactly the nav.json bar, with the current item marked', () => {
  const want = expectedBar();
  const bars = [];
  for (const [page, current] of Object.entries(PAGES)) {
    const h = header(dist(page));
    assert.deepEqual(barLinks(h, `${nav.origins.info}/${page.replace('index.html', '')}`), want, page);
    assert.doesNotMatch(h, /discord/i, `${page}: no Discord in the top bar`);
    const marked = [...h.matchAll(/<a\b[^>]*aria-current="page"[^>]*data-efmh-id="([^"]+)"|<a\b[^>]*data-efmh-id="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1] ?? m[2]);
    const player = /<a class="efmh-gold efmh-player"[^>]*aria-current="page"/.test(h);
    if (current === 'player') assert.ok(player, `${page}: Web Player marked`);
    else assert.ok(marked.length > 0 && marked.every((id) => id === current), `${page}: ${current} marked (got ${marked})`);
    bars.push(h.replace(/\saria-current="[^"]*"/g, ''));
  }
  assert.ok(bars.every((b) => b === bars[0]), 'the bar markup is identical on every page (apart from aria-current)');
});

test('menus are <details>/<summary> (work with JavaScript off) and the home page has the anchors', () => {
  const h = header(dist('index.html'));
  assert.match(h, /<details class="efmh-dd" data-efmh-menu>\s*<summary class="efmh-link"/);
  assert.match(h, /<details class="efmh-burger" data-efmh-menu>\s*<summary/);
  const home = dist('index.html');
  // Every in-page anchor the bar links to (/#…) is a real, unique element id
  // on the home page (\sid= so data-efmh-id doesn't count).
  const anchors = nav.items.filter((i) => i.site === 'info' && i.path?.startsWith('/#')).map((i) => i.path.slice(2));
  assert.deepEqual(anchors, ['listen', 'about', 'stats', 'contact']);
  for (const id of anchors) assert.equal(home.match(new RegExp(`\\sid="${id}"`, 'g'))?.length, 1, `#${id} exists once`);
  // The pop-out stays chrome-free.
  assert.match(readRoot('src/styles/player.css'), /html\.efm-popout \.efmh/);
});

test('the portal renders the same data (imports the shared copies, no hard-coded bar)', () => {
  const bar = readRoot('music/src/components/SiteBar.tsx');
  assert.match(bar, /from '@\/shared\/nav\.json'/);
  for (const label of ['Listen', 'About', 'Stats', 'Contact', 'Web Player', 'Submit music']) assert.doesNotMatch(bar, new RegExp(`>${label}<`), `SiteBar.tsx hard-codes "${label}"`);
  // The shared bar CSS reaches the portal either from layout.tsx directly or
  // (v0.4.1, one stylesheet) via globals.css, which the layout imports.
  const layout = readRoot('music/src/app/layout.tsx');
  const globals = readRoot('music/src/app/globals.css');
  assert.ok(
    /@\/shared\/efm-bar\.css/.test(layout) || (/globals\.css/.test(layout) && /@import\s+["']\.\.\/shared\/efm-bar\.css["']/.test(globals)),
    'the portal must load the shared efm-bar.css (layout.tsx or globals.css @import)',
  );
  const portalTest = readRoot('music/test/ui/site-bar.test.tsx');
  assert.match(portalTest, /expectedBar/);
});
