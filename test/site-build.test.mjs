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
import {
  createNowPlayingPoller,
  stationUnavailable,
  SLOW_RETRY_AFTER,
  SLOW_RETRY_MS,
} from '../src/scripts/np-core.ts';
import { DEFAULT_EXCLUDE_PLAYLISTS } from '../server/stats.mjs';
import {
  CONTACT_AVATAR_URL,
  CONTACT_STATION_NAME,
  NEWDAYRP_PROFILE_PATTERN,
} from '../server/index.mjs';

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
  assert.match(html, /<label class="efmp-select"[^>]*\shidden[\s>]/, 'stream picker starts hidden: it only shows with 2+ mounts');
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
  // Hero: player + the Recently played / Requested card + the three buttons.
  assert.match(html, /id="recent-list"/);
  assert.match(html, /id="req-pending-list"/);
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
  // Both tabs of the songs card share one constant-height body.
  assert.match(html, /class="hm-tab-body"[^>]*>\s*<div role="tabpanel" id="songs-panel-recent"[\s\S]*?id="songs-panel-requested"/);
  // Up next: one fixed-height row, a note layer and a track layer.
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

const src = (p) => readFileSync(join(ROOT, p), 'utf8');

test('home: Up next shows for the whole song — no reveal delay, no "near the end" note', () => {
  const js = src('src/scripts/nowplaying.ts');
  assert.doesNotMatch(js, /UP_NEXT_REVEAL|REVEAL_SEC|remaining\s*<=/, 'no reveal threshold');
  const html = read('index.html');
  assert.doesNotMatch(html, /near the end of this song/i);
  const row = /<div[^>]*id="np-up-next"[^>]*>/.exec(html)?.[0] ?? '';
  // The neutral lines for "not known yet" / an ad next / a live set are copy.
  assert.ok(row.includes(`data-choosing="${site.home.upNext.choosing}"`), 'choosing copy');
  assert.ok(row.includes(`data-break="${site.home.upNext.stationBreak}"`), 'station-break copy');
  assert.match(row, /data-exclude="[^"]*2Ads/, 'break filter playlists handed to the script');
  assert.match(html, /id="up-next-note"[^>]*>[^<]+</, 'note row is never empty');
  assert.match(html, /id="up-next-when"/, 'countdown slot');
  // The row's single grid column must be allowed to shrink (minmax(0, 1fr)),
  // or a long title grows the implicit auto column and clips the REQUESTED
  // badge and the countdown off the row's overflow:hidden edge.
  assert.match(src('src/components/PlayerCard.astro'), /#np-up-next\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  // The Web Player never had a reveal delay; keep it that way.
  assert.doesNotMatch(src('src/scripts/player.ts'), /REVEAL/);
  assert.match(src('src/scripts/player.ts'), /qualityWrap\.hidden = options\.length < 2/, 'stream picker unhides only with 2+ mounts');
});

test('home: ONE side card with Recently played / Requested tabs (ARIA tablist), no standalone Requested card', () => {
  const html = read('index.html');
  const aside = /<aside class="efm-sidebar[^"]*"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? '';
  assert.equal(aside.match(/<section\b/g)?.length, 1, 'a single sidebar card');
  assert.doesNotMatch(html, /id="req-pending-section"|id="req-h"|id="recent-h"|hm-req-body/, 'old cards are gone');
  assert.ok(!existsSync(join(ROOT, 'src/components/RequestedSongs.astro')), 'RequestedSongs.astro removed');
  assert.ok(!existsSync(join(ROOT, 'src/components/RecentlyPlayed.astro')), 'RecentlyPlayed.astro merged');
  // Tablist semantics.
  assert.match(aside, /role="tablist"[^>]*aria-label="[^"]+"/);
  const tabs = [...aside.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tabs.length, 2, 'two tabs');
  const attr = (tag, a) => new RegExp(`\\s${a}="([^"]*)"`).exec(tag)?.[1];
  assert.deepEqual(tabs.map((t) => attr(t, 'aria-selected')), ['true', 'false'], 'Recently played selected by default');
  assert.deepEqual(tabs.map((t) => attr(t, 'tabindex')), ['0', '-1'], 'roving tabindex');
  for (const t of tabs) {
    const panel = attr(t, 'aria-controls');
    const id = attr(t, 'id');
    assert.ok(panel && id, 'tab has id + aria-controls');
    assert.match(aside, new RegExp(`role="tabpanel" id="${panel}"[^>]*aria-labelledby="${id}"`), `${panel} labelled by ${id}`);
  }
  assert.match(aside, /id="songs-panel-requested"[^>]*\shidden/, 'Requested panel hidden at first');
  // Order: tabs are Recently played, then Requested with the count badge.
  assert.match(aside, new RegExp(`${site.home.songs.recent}[\\s\\S]*?role="tab"[\\s\\S]*?${site.home.songs.requested}[\\s\\S]*?id="req-pending-count"`));
  // Empty Requested tab: the note + a button that opens the request pop-up.
  assert.match(aside, /id="req-pending-empty"[\s\S]*?data-open="request"/);
  // Arrow-key handling ships with the page.
  const comp = src('src/components/SongsCard.astro');
  for (const k of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(comp.includes(`'${k}'`), `${k} key`);
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

test('the contact forms post to the same-origin relay; no page loads a runtime config or a delivery URL', () => {
  for (const page of ['index.html', 'events/index.html', 'player/index.html']) {
    const html = read(page);
    // Substring checks on purpose: any occurrence anywhere is a failure
    // (an unanchored host regex here trips CodeQL's missing-anchor rule).
    const lower = html.toLowerCase();
    assert.ok(!lower.includes('discord.com'), `${page} mentions discord.com`);
    assert.ok(!lower.includes('api/webhooks'), `${page} mentions api/webhooks`);
    assert.doesNotMatch(html, /efm-runtime-config/, page);
    assert.doesNotMatch(html, /__EFM_CONFIG__\.contact|getWebhook/, page);
  }
  assert.match(read('index.html'), /fetch\('\/contact\/message'/);
  assert.match(read('events/index.html'), /fetch\('\/contact\/event'/);
});

test('the sidecar contact relay mirrors site.config (avatar, name, profile pattern)', () => {
  assert.equal(CONTACT_AVATAR_URL, site.discord.avatarUrl);
  assert.equal(CONTACT_STATION_NAME, site.name);
  assert.equal(NEWDAYRP_PROFILE_PATTERN, site.newDayRpProfilePattern);
});

test('no built info page mentions Discord (owner decision) or spells the brand "Euphoric FM"', () => {
  for (const page of ['index.html', 'events/index.html', 'player/index.html']) {
    const html = read(page);
    assert.doesNotMatch(html, /discord/i, page);
    assert.doesNotMatch(html, /Euphoric FM/, `${page}: the spelling is "EuphoricFM"`);
  }
});

test('copy: sentence case on /events/ and the pop-up headings, FAQ names the Requested tab', () => {
  const events = read('events/index.html');
  for (const t of ['Plan Your Event', 'How It Works', 'Tell Us About Your Event', 'We Build the Sound', 'Your Event. Your Sound.', 'Good For', 'Happening Now', 'On the Calendar', 'Listen Live', 'Send Inquiry', 'Plan an Event']) {
    assert.ok(!events.includes(t), `/events/ still says "${t}"`);
  }
  assert.ok(events.includes('<meta name="description" content="Bring EuphoricFM to your next event'), 'events meta');
  assert.ok(events.includes('<meta property="og:description" content="Bring EuphoricFM to your next event'), 'events og');
  const home = read('index.html');
  assert.match(home, />Request a song<\/h2>/);
  assert.match(home, />Contact us<\/h2>/);
  assert.match(home, />Plan an event with EuphoricFM<\/h2>/);
  assert.doesNotMatch(home, /Requested songs/);
  assert.ok(site.home.faq.items.some((i) => i.a.includes('the Requested tab')), 'FAQ points at the Requested tab');
});

test('portal links: every Submit music goes to /submit, the fix link keeps its intent, one product name', () => {
  const home = read('index.html');
  const submits = [...home.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>(?:(?!<\/a>)[\s\S])*?Submit music(?:(?!<\/a>)[\s\S])*?<\/a>/g)].map((m) => m[1]);
  assert.ok(submits.length >= 3, `bar, #music and footer (found ${submits.length})`);
  for (const href of submits) assert.equal(href, 'https://music.euphoric.fm/submit');
  assert.match(home, /<a href="https:\/\/music\.euphoric\.fm\/library\?intent=edit"[^>]*>Fix or remove a song<\/a>/, 'footer fix link');
  const nav = JSON.parse(src('shared/nav.json'));
  assert.equal(nav.musicMenu.title, 'EuphoricFM Music Portal');
  assert.equal(nav.sheet.musicHeading, 'EuphoricFM Music Portal');
});

test('shared phone bar fits a 320 px viewport (row budget in efm-bar.css)', () => {
  const css = src('shared/efm-bar.css');
  assert.match(css, /@media \(max-width: 359px\) \{\s*\.efmh-in \{ gap: 4px; \}\s*\.efmh-player \{ padding: 0 8px; \}/);
  assert.match(css, /@media \(max-width: 339px\) \{ \.efmh-brand \{ min-width: 124px; \} \}/);
  assert.match(css, /@media \(max-width: 339px\) \{\s*\.efmh-euph \{ font-size: 14px; \}\s*\.efmh-fm \{ font-size: 18px; \}/);
});

test('stats.ts is not in the home entry script (loaded when #stats nears the viewport)', () => {
  const html = read('index.html');
  const entry = /<script type="module" src="(\/_astro\/BaseLayout\.astro_astro_type_script[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(entry, 'home entry script');
  const js = read(entry.slice(1));
  assert.doesNotMatch(js, /stats-detail-overlay/, 'stats driver is a separate chunk');
  assert.match(js, /import\(["'][^"']*stats[^"']*\.js["']\)|stats\.[\w-]+\.js/, 'lazy import of the stats chunk');
});

test('share previews: og:image is a real 1200x630 PNG under 100 KB', () => {
  const html = read('index.html');
  assert.match(html, /<meta property="og:image" content="https:\/\/info\.euphoric\.fm\/images\/og\.png"/);
  const f = dist('images/og.png');
  assert.ok(existsSync(f), 'dist/images/og.png');
  const b = readFileSync(f);
  assert.equal(b.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [1200, 630]);
  assert.ok(b.length <= 100_000, `og.png is ${b.length} bytes (max 100 KB)`);
});

test('robots.txt is a real file, and the dead PWA bits are gone', () => {
  assert.match(read('robots.txt'), /^User-agent/);
  for (const f of ['manifest.webmanifest', 'icon.svg']) {
    assert.ok(!existsSync(dist(f)), `dist/${f} must not come back (the CEF first-paint bug)`);
  }
  for (const page of ['index.html', 'events/index.html', 'player/index.html']) {
    assert.doesNotMatch(read(page), /rel="manifest"/, page);
  }
});

test('wordmark script font: a WOFF2 subset under 20 KB, listed before the TTF, preloaded', () => {
  const woff2 = readFileSync(dist('fonts/CortadoScript-Regular.woff2'));
  assert.equal(woff2.subarray(0, 4).toString(), 'wOF2');
  assert.ok(woff2.length <= 20_000, `CortadoScript-Regular.woff2 is ${woff2.length} bytes (max 20 KB)`);
  assert.ok(existsSync(dist('fonts/CortadoScript-Regular.ttf')), 'TTF kept (fallback + docs/og)');
  const face = /@font-face\s*\{[^}]*font-family:\s*'Cortado Script'[^}]*\}/.exec(src('src/styles/global.css'))?.[0] ?? '';
  assert.match(face, /CortadoScript-Regular\.woff2'\) format\('woff2'\),\s*url\('\/fonts\/CortadoScript-Regular\.ttf'\)/);
  for (const page of ['index.html', 'events/index.html', 'player/index.html']) {
    const html = read(page);
    for (const f of ['Begaron-Regular.woff2', 'CortadoScript-Regular.woff2']) {
      assert.match(html, new RegExp(`<link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/${f}"`), `${page} preloads ${f}`);
    }
  }
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

// ---- Station offline (np-core poller) ----------------------------------------------

test('now-playing poller: a failing API (5xx, network, timeout) is reported and turns the pages offline', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let mode = '502';
  let calls = 0;
  const fetchFn = async (url, init) => {
    calls++;
    assert.equal(url, 'https://euphoric.fm/api/nowplaying/euphoricfm');
    assert.ok(init.signal instanceof AbortSignal, 'every request carries a timeout signal');
    assert.equal(init.cache, 'no-store');
    if (mode === '502') return new Response('bad gateway', { status: 502 });
    if (mode === 'network') throw new TypeError('fetch failed');
    if (mode === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    return Response.json({ now_playing: { sh_id: 1 } });
  };
  let now = 1_000_000;
  const errors = [];
  const data = [];
  const poller = createNowPlayingPoller({
    url: 'https://euphoric.fm/api/nowplaying/euphoricfm',
    onData: (d) => data.push(d),
    onError: (n) => errors.push(n),
    fetchFn,
    timeoutMs: 30,
    now: () => now,
  });

  // First poll fails with nothing on screen yet → offline straight away.
  await poller.poll();
  assert.deepEqual(errors, [1]);
  assert.equal(stationUnavailable(1, false), true, 'no data yet: first miss shows offline');
  assert.equal(stationUnavailable(1, true), false, 'with data: one dropped poll does not flicker');

  // Network error, then a hanging request that the timeout aborts.
  mode = 'network';
  await poller.poll();
  mode = 'hang';
  await poller.poll();
  assert.deepEqual(errors, [1, 2, 3]);
  assert.equal(stationUnavailable(2, true), true, 'with data: offline after two misses in a row');

  // Slower retry after SLOW_RETRY_AFTER misses in a row.
  assert.equal(SLOW_RETRY_AFTER, 3);
  const before = calls;
  now += 5000;
  await poller.tick();
  assert.equal(calls, before, 'no request 5 s after the third miss');
  now += SLOW_RETRY_MS;
  mode = 'ok';
  await poller.tick();
  assert.equal(calls, before + 1, 'retried after SLOW_RETRY_MS');

  // Recovery: data flows again and the miss counter resets.
  assert.equal(data.length, 1);
  assert.equal(poller.failures(), 0);
});

test('now-playing poller: only one request in flight at a time', async () => {
  let calls = 0;
  let release;
  const fetchFn = () => {
    calls++;
    return new Promise((resolve) => { release = () => resolve(Response.json({})); });
  };
  const poller = createNowPlayingPoller({ url: 'x', onData: () => {}, onError: () => {}, fetchFn });
  const first = poller.poll();
  await poller.poll();
  await poller.tick();
  assert.equal(calls, 1, 'a slow API does not stack requests');
  release();
  await first;
  const second = poller.poll();
  assert.equal(calls, 2, 'the next poll goes out once the first settled');
  release();
  await second;
});

test('offline copy ships with both players', () => {
  assert.equal(site.player.offline, 'Station offline — retrying');
  const home = read('index.html');
  assert.ok(home.includes(`data-offline="${site.player.offline}"`), 'home card');
  assert.ok(home.includes(`data-offline="${site.home.upNext.offline}"`), 'up next row');
  assert.ok(home.includes(`data-offline="${site.home.songs.offline}"`), 'recently played');
  const player = read('player/index.html');
  const cfg = /data-player-config="([^"]*)"/.exec(player)?.[1] ?? '';
  const parsed = JSON.parse(cfg.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  assert.equal(parsed.offline, site.player.offline);
  assert.equal(parsed.playFailed, site.player.playFailed);
  // A rejected audio.play() reaches a toast instead of only console.warn.
  assert.match(src('src/scripts/stream-audio.ts'), /onPlayError\?\.\(err\)/);
  assert.match(src('src/components/PlayerCard.astro'), /onPlayError: \(\) => showToast\(site\.player\.playFailed\)/);
  assert.match(src('src/scripts/player.ts'), /onPlayError: \(\) => showToast\(pc\.playFailed\)/);
});

// ---- Home card parity with /player/ -------------------------------------------------

test('home card + Recently played use the break filter, clamp the time, refresh pending every 30 s', () => {
  const js = src('src/scripts/nowplaying.ts');
  assert.match(js, /history\.filter\(\(h\) => !isBreakEntry\(h, excludePlaylists\)\)\.slice\(0, 4\)/, 'Recently played skips ads/imaging');
  assert.match(js, /const brk = isBreakEntry\(np, excludePlaylists\)/, 'now playing shows a station break');
  assert.match(js, /Math\.min\(duration, Math\.max\(0, \(Date\.now\(\) - playedAt\) \/ 1000\)\)/, 'elapsed clamped to the song length');
  assert.match(js, /const PENDING_REFRESH_MS = 30_000;/);
  // refreshPending runs on a track change / 30 s timer, not on every poll.
  const onNp = /const onNowPlaying = [\s\S]*?\n  \};/.exec(js)?.[0] ?? '';
  assert.equal(onNp.match(/refreshPending\(\)/g)?.length, 1, 'one call, inside the sh_id change block');
  assert.match(onNp, /np\.sh_id !== lastShId\) \{[\s\S]*?refreshPending\(\);[\s\S]*?\n    \}/);
  const card = /<div id="np-card"[^>]*>/.exec(read('index.html'))?.[0] ?? '';
  assert.ok(card.includes(`data-break-title="${site.player.breakTitle}"`));
  assert.ok(card.includes(`data-break-artist="${site.player.breakArtist}"`));
});

test('/player/#history opens the full Song history', () => {
  assert.match(src('src/scripts/player.ts'), /location\.hash === '#history'\) setExpanded\(true\)/);
  assert.match(src('src/scripts/player.ts'), /addEventListener\('hashchange', expandForHash\)/);
  assert.match(read('index.html'), /href="\/player\/#history"/);
});
