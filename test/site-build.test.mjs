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

test('home keeps its bundle and gains a visible Web Player button', () => {
  const html = read('index.html');
  assert.match(html, /id="np-card"/);
  assert.match(html, /<a href="\/player\/" id="open-player" class="btn btn-player">/);
  assert.match(html, /Web Player<\/a>/);
  assert.match(html, /efm-runtime-config\.js/);
  assert.match(html, /BaseLayout\.astro_astro_type_script/);
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
