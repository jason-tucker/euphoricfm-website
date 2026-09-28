// Site build checks + Web Player helper unit tests.
//
//   pnpm build && pnpm test:site      (node --test test/*.test.mjs)
//
// Node 24 strips TypeScript types natively, so the pure helpers in
// src/lib/player-data.ts and the copy in src/site.config.ts are imported
// straight from source. The dist/ checks need a finished `pnpm build`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildM3u,
  buildPls,
  isBreakEntry,
  streamOptions,
} from '../src/lib/player-data.ts';
import { site } from '../src/site.config.ts';
import { DEFAULT_EXCLUDE_PLAYLISTS } from '../server/stats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => join(ROOT, 'dist', p);
const read = (p) => {
  assert.ok(existsSync(dist(p)), `dist/${p} is missing — run \`pnpm build\` first`);
  return readFileSync(dist(p), 'utf8');
};

// ---- Build output -----------------------------------------------------------

test('dist/player/index.html is built as a real page with its own title + meta', () => {
  const html = read('player/index.html');
  assert.match(html, /<title>Web Player — EuphoricFM<\/title>/);
  assert.ok(html.includes(`<meta name="description" content="${site.player.description}"`));
  assert.match(html, /<link rel="canonical" href="https:\/\/info\.euphoric\.fm\/player\/"/);
  assert.match(html, /id="efmp"/, 'player root');
  assert.match(html, /class="efmp-mini"/, 'pop-out strip');
  assert.match(html, /id="efmp-quality"/, 'stream picker');
  assert.match(html, /id="efmp-history"/, 'song history');
  assert.match(html, /id="request-overlay"/, 'request modal is reused');
  assert.match(html, /\/player\/\?popout=1/, 'pop-out link');
  assert.match(html, /download="euphoricfm\.pls"/);
  assert.match(html, /download="euphoricfm\.m3u"/);
  // Its own entry script, not the full-site bundle.
  assert.match(html, /src="\/_astro\/player\.astro[^"]*\.js"/);
  assert.doesNotMatch(html, /BaseLayout\.astro_astro_type_script/);
  assert.doesNotMatch(html, /id="np-card"/, 'not the home page');
});

test('the Web Player page never mentions Discord (and skips the webhook config)', () => {
  const html = read('player/index.html');
  assert.doesNotMatch(html, /discord/i);
  assert.doesNotMatch(html, /efm-runtime-config\.js/);
});

test('home keeps its bundle and links the Web Player from the hero', () => {
  const html = read('index.html');
  assert.match(html, /id="np-card"/);
  assert.match(html, /<a href="\/player\/" id="open-player" class="btn btn-ghost">/);
  assert.match(html, /efm-runtime-config\.js/);
  assert.match(html, /BaseLayout\.astro_astro_type_script/);
});

// ---- Release 4: the one-page home ----------------------------------------------

/** Every element id on a page, in document order (\sid= so data-*-id doesn't count). */
const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

test('home: the sections are there, in the approved order, each once', () => {
  const all = ids(read('index.html'));
  const order = ['listen', 'about', 'events', 'music', 'ways', 'stats', 'contact', 'faq'];
  for (const id of order) assert.equal(all.filter((x) => x === id).length, 1, `#${id} exactly once`);
  const pos = order.map((id) => all.indexOf(id));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, `section order ${order.join(' → ')}`);
  for (const id of new Set(all)) assert.equal(all.filter((x) => x === id).length, 1, `duplicate id "${id}"`);
});

test('home: the pieces each section promises', () => {
  const html = read('index.html');
  // Hero: player + recently played + requested songs + the three buttons.
  assert.match(html, /id="recent-list"/);
  assert.match(html, /id="req-pending-section"/);
  assert.match(html, /id="open-request"[^>]*data-open="request"|data-open="request"[^>]*id="open-request"/);
  assert.match(html, /href="#ways"/);
  // About: the live facts card (filled by station-facts.ts), no team section.
  assert.match(html, /id="about-facts"/);
  assert.doesNotMatch(html, /\bid="team"|>Team</i);
  // Events teaser reuses the live status block from /events.
  assert.match(html, /id="evst-card"/);
  assert.match(html, /href="\/events\/"[^>]*data-open="event-inquiry"/);
  // For artists → the portal (submit + library intents).
  assert.match(html, /href="https:\/\/music\.euphoric\.fm\/"/);
  assert.match(html, /href="https:\/\/music\.euphoric\.fm\/library\?intent=edit"/);
  assert.match(html, /href="https:\/\/music\.euphoric\.fm\/library\?intent=remove"/);
  // Listen anywhere: playlist files, pop-out and the copyable stream URL.
  assert.match(html, /download="euphoricfm\.pls"/);
  assert.match(html, /download="euphoricfm\.m3u"/);
  assert.match(html, /\/player\/\?popout=1/);
  assert.ok(html.includes(`<code id="ways-stream-url">${site.azuracast.streamUrl}</code>`));
  // Stats: condensed + a toggle for the full charts.
  assert.match(html, /<section id="stats"/);
  assert.match(html, /id="stats-full-toggle"[^>]*aria-controls="stats-full"|aria-controls="stats-full"[^>]*id="stats-full-toggle"/);
  assert.match(html, /id="stats-full" class="hidden/);
  // Get in touch: the three existing pop-ups; the ad keeps its in-universe copy.
  for (const o of ['contact', 'business', 'event-inquiry']) assert.match(html, new RegExp(`data-open="${o}"`));
  for (const ov of ['request-overlay', 'contact-overlay', 'business-overlay', 'event-overlay']) assert.match(html, new RegExp(`id="${ov}"`));
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  for (const perk of site.businessAd.perks) assert.ok(html.includes(esc(perk)), `ad copy kept: ${perk}`);
  assert.ok(site.businessAd.perks.includes('Average of 120,000 listeners per day'), 'in-universe figure stays');
  // FAQ: six native <details>.
  const faq = /<section id="faq"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  assert.equal(faq.match(/<details\b/g)?.length, site.home.faq.items.length);
  assert.equal(site.home.faq.items.length, 6);
  // The old six-button action row is gone.
  assert.doesNotMatch(html, /efm-action-row|id="open-contact"|id="open-business"/);
});

test('home: no layout shift from requests or up-next, no dead controls without JS, no View Transitions', () => {
  const html = read('index.html');
  // Requested songs: fixed-height body with the empty note inside it.
  assert.match(html, /class="hm-req-body"[^>]*>\s*<p id="req-pending-empty"[\s\S]*?id="req-pending-list"/);
  // Up next: the row always shows (a note until the next track is known).
  assert.match(html, /id="np-up-next"[\s\S]*?class="np-un-wait[\s\S]*?class="np-un-track/);
  // JS off: html.efm-js is set by the pre-paint script; live facts + transport
  // are marked JS-only and the player explains itself in a <noscript>.
  assert.match(html, /classList\.add\('efm-js'\)/);
  for (const key of ['since', 'listens', 'tracks', 'requests', 'peak']) {
    assert.match(html, new RegExp(`class="[^"]*efm-js-only[^"]*"[^>]*data-fact="${key}"`), `fact ${key} JS-only`);
  }
  assert.match(html, /<noscript>[\s\S]*?href="#ways"[\s\S]*?<\/noscript>/);
  // Pop-ups open directly (a whole-page View Transition delayed them seconds).
  for (const page of ['index.html', 'events/index.html', 'player/index.html']) {
    assert.doesNotMatch(read(page), /startViewTransition/, `${page} uses no View Transition`);
  }
  // No unbacked claim in the facts card.
  assert.doesNotMatch(html, /live specials/i);
});

test('pop-ups sit above the sticky top bar: outside <main> (a z-[1] stacking context) and z-[70]', () => {
  for (const [page, list] of Object.entries({ 'events/index.html': ['event-overlay'], 'player/index.html': ['request-overlay'] })) {
    const html = read(page);
    for (const ov of list) assert.ok(html.indexOf(`id="${ov}"`) > html.indexOf('</main>'), `${page}: #${ov} after </main>`);
  }
  const html = read('index.html');
  const mainEnd = html.indexOf('</main>');
  for (const ov of ['request-overlay', 'contact-overlay', 'business-overlay', 'event-overlay', 'stats-detail-overlay']) {
    const cls = new RegExp(`id="${ov}"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*id="${ov}"`).exec(html);
    assert.ok(cls, ov);
    assert.match(cls[1] ?? cls[2], /\bz-\[70\]/, `${ov} above the bar`);
    assert.ok(html.indexOf(`id="${ov}"`) > mainEnd, `#${ov} is outside <main>`);
  }
});

test('no built info page mentions Discord (owner decision)', () => {
  for (const page of ['index.html', 'events/index.html', 'player/index.html']) {
    assert.doesNotMatch(read(page), /discord/i, page);
  }
});

test('stats.ts is not in the home entry script (loaded when #stats nears the viewport)', () => {
  const html = read('index.html');
  const entry = /<script type="module" src="(\/_astro\/BaseLayout\.astro_astro_type_script[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(entry, 'home entry script');
  const js = read(entry.slice(1));
  assert.doesNotMatch(js, /stats-detail-overlay/, 'stats driver is a separate chunk');
  assert.match(js, /import\(["'][^"']*stats[^"']*\.js["']\)|stats\.[\w-]+\.js/, 'lazy import of the stats chunk');
});

test('share previews: og:image is a real 1200x630 PNG', () => {
  const html = read('index.html');
  assert.match(html, /<meta property="og:image" content="https:\/\/info\.euphoric\.fm\/images\/og\.png"/);
  const f = dist('images/og.png');
  assert.ok(existsSync(f), 'dist/images/og.png');
  const b = readFileSync(f);
  assert.equal(b.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [1200, 630]);
});

// ---- Config drift -------------------------------------------------------------

test('player break filter mirrors the stats sidecar exclude list', () => {
  assert.deepEqual(
    [...site.player.excludePlaylists],
    DEFAULT_EXCLUDE_PLAYLISTS.split(',').map((s) => s.trim()),
  );
});

// ---- Helpers --------------------------------------------------------------------

const EX = site.player.excludePlaylists;
const song = (o = {}) => ({ id: 'x', text: 'A - B', artist: 'A', title: 'B', album: '', genre: '', art: '', isrc: '', lyrics: '', ...o });

test('isBreakEntry: blank tags and excluded playlists are breaks, songs are not', () => {
  assert.equal(isBreakEntry({ song: song(), playlist: '1General Rotation' }, EX), false);
  assert.equal(isBreakEntry({ song: song(), playlist: '' }, EX), false); // requests have playlist ""
  assert.equal(isBreakEntry({ song: song({ artist: '', title: '', text: '' }), playlist: '' }, EX), true);
  assert.equal(isBreakEntry({ song: song({ artist: '', title: '', text: ' - ' }), playlist: '' }, EX), true);
  assert.equal(isBreakEntry({ song: song(), playlist: '2Ads' }, EX), true);
  assert.equal(isBreakEntry({ song: song(), playlist: '4euphoricfm ' }, EX), true);
  assert.equal(isBreakEntry(null, EX), true);
});

const MOUNT = {
  id: 1, name: 'EuphoricFM Radio', url: 'https://euphoric.fm/listen/euphoricfm/radio.mp3',
  bitrate: 128, format: 'mp3', path: '/radio.mp3', is_default: true,
};

test('streamOptions: labels mounts, default first, drops foreign/insecure/duplicate URLs', () => {
  const opts = streamOptions([
    { ...MOUNT, id: 2, name: 'Low', url: 'https://euphoric.fm/listen/euphoricfm/low.aac', bitrate: 64, format: 'aac', is_default: false },
    MOUNT,
    { ...MOUNT, id: 3, url: 'https://evil.example/radio.mp3' },
    { ...MOUNT, id: 4, url: 'http://euphoric.fm/listen/euphoricfm/radio.mp3' },
    { ...MOUNT, id: 5 }, // duplicate URL
    { ...MOUNT, id: 6, url: 'not a url' },
  ], 'https://euphoric.fm');
  assert.deepEqual(opts, [
    { url: MOUNT.url, label: 'MP3 · 128k', name: 'EuphoricFM Radio', isDefault: true },
    { url: 'https://euphoric.fm/listen/euphoricfm/low.aac', label: 'AAC · 64k', name: 'Low', isDefault: false },
  ]);
  assert.deepEqual(streamOptions(undefined, 'https://euphoric.fm'), []);
});

test('playlist files: .pls and .m3u list every mount, one line per title', () => {
  const opts = streamOptions([{ ...MOUNT, name: 'Evil\nFile2=https://x' }], 'https://euphoric.fm');
  const pls = buildPls('EuphoricFM', opts);
  assert.equal(pls, [
    '[playlist]',
    'NumberOfEntries=1',
    `File1=${MOUNT.url}`,
    'Title1=EuphoricFM – Evil File2=https://x (MP3 · 128k)',
    'Length1=-1',
    'Version=2',
    '',
  ].join('\n'));
  const m3u = buildM3u('EuphoricFM', opts);
  assert.equal(m3u, ['#EXTM3U', '#EXTINF:-1,EuphoricFM – Evil File2=https://x (MP3 · 128k)', MOUNT.url, ''].join('\n'));
});
