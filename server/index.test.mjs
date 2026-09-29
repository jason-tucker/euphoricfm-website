// Tests for the efm-requests shared pending-requests service.
//
// Run: `node --test server/` (built-in node:test, zero deps). The module is
// imported for its factory + sanitisers — importing has no side effects (no
// listen, no timers), see the invokedDirectly guard in index.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createStore,
  sanitizeArt,
  sanitizeText,
  clientIp,
  sanitizeMultiline,
  createContactRelay,
  MAX_ENTRIES,
  MAX_BODY_BYTES,
  CONTACT_MAX_BODY_BYTES,
  CONTACT_RATE_LIMIT_MAX,
  CONTACT_RATE_LIMIT_WINDOW_MS,
} from './index.mjs';

// ---- Helpers ---------------------------------------------------------------

function withServer(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'efm-requests-'));
  const store = createStore({
    storePath: join(dir, 'pending.json'),
    rateLimitMax: opts.rateLimitMax ?? 1000, // high by default so tests don't trip it
    rateLimitWindowMs: opts.rateLimitWindowMs ?? 60_000,
  });
  const server = createServer(store.handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        store,
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); })),
      });
    });
  });
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/requests/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const getPending = async (base) => (await fetch(`${base}/requests/pending`)).json();

// ---- Sanitiser unit tests (the core XSS fix) -------------------------------

test('sanitizeArt allows absolute http(s) and root-relative URLs', () => {
  assert.equal(
    sanitizeArt('https://euphoric.fm/api/station/euphoricfm/art/abc'),
    'https://euphoric.fm/api/station/euphoricfm/art/abc',
  );
  assert.equal(sanitizeArt('http://example.com/a.png'), 'http://example.com/a.png');
  assert.equal(sanitizeArt('/efm-art/api/station/euphoricfm/art/abc'), '/efm-art/api/station/euphoricfm/art/abc');
});

test('sanitizeArt strips attribute-breakout / XSS payloads to empty', () => {
  // The exact stored-XSS vector: breaking out of <img src="${art}">.
  assert.equal(sanitizeArt('x" onerror="alert(document.domain)"'), '');
  assert.equal(sanitizeArt('"><script>alert(1)</script>'), '');
  assert.equal(sanitizeArt('javascript:alert(1)'), '');
  assert.equal(sanitizeArt('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(sanitizeArt('//evil.example/x.png'), ''); // protocol-relative -> rejected
  assert.equal(sanitizeArt('/x"onerror=alert(1)'), ''); // quote in relative path -> rejected
  assert.equal(sanitizeArt(''), '');
  assert.equal(sanitizeArt(null), '');
  assert.equal(sanitizeArt('x'.repeat(600)), ''); // over length cap
});

test('sanitizeText removes control chars and caps length', () => {
  assert.equal(sanitizeText('a\nb\tc', 50), 'a b c');
  assert.equal(sanitizeText('  hi  ', 50), 'hi');
  assert.equal(sanitizeText('abcdef', 3), 'abc');
  assert.equal(sanitizeText(null, 50), '');
});

test('clientIp uses the rightmost (trusted) X-Forwarded-For, else the socket peer', () => {
  // Rightmost = the hop our own Caddy set; a client-supplied prefix can't spoof it.
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: {} }), '5.6.7.8');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9' }, socket: {} }), '9.9.9.9');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '8.8.8.8' } }), '8.8.8.8');
});

test('a spoofed X-Forwarded-For prefix cannot evade the rate limiter', async () => {
  // Each request carries a different *leftmost* XFF, but Caddy's appended real
  // IP (rightmost) is constant, so the limiter still bites.
  const s = await withServer({ rateLimitMax: 2 });
  try {
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const r = await post(s.base, { id: `sp-${i}`, title: 't' }, { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [200, 200, 429, 429]);
  } finally {
    await s.close();
  }
});

// ---- HTTP integration tests ------------------------------------------------

test('POST then GET round-trips a sanitised entry', async () => {
  const s = await withServer();
  try {
    const r = await post(s.base, {
      id: 'song-1',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      art: 'https://euphoric.fm/api/station/euphoricfm/art/abc',
    });
    assert.equal(r.status, 200);
    const pending = await getPending(s.base);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'song-1');
    assert.equal(pending[0].art, 'https://euphoric.fm/api/station/euphoricfm/art/abc');
  } finally {
    await s.close();
  }
});

test('stored XSS in art is neutralised end-to-end', async () => {
  const s = await withServer();
  try {
    await post(s.base, { id: 'evil', title: 't', artist: 'a', art: 'z" onerror="alert(1)' });
    const pending = await getPending(s.base);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].art, ''); // payload dropped, never reaches the client
    assert.ok(!JSON.stringify(pending).includes('onerror'));
  } finally {
    await s.close();
  }
});

test('POST without an id is rejected 400', async () => {
  const s = await withServer();
  try {
    const r = await post(s.base, { title: 'no id' });
    assert.equal(r.status, 400);
    assert.equal((await getPending(s.base)).length, 0);
  } finally {
    await s.close();
  }
});

test('resubmitting the same id dedupes', async () => {
  const s = await withServer();
  try {
    await post(s.base, { id: 'dup', title: 'first' });
    await post(s.base, { id: 'dup', title: 'second' });
    const pending = await getPending(s.base);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].title, 'second');
  } finally {
    await s.close();
  }
});

test('the pending list is capped at MAX_ENTRIES', async () => {
  const s = await withServer();
  try {
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      await post(s.base, { id: `song-${i}`, title: `t${i}` });
    }
    const pending = await getPending(s.base);
    assert.equal(pending.length, MAX_ENTRIES);
    // Oldest were shifted off; the newest id survives.
    assert.ok(pending.some((p) => p.id === `song-${MAX_ENTRIES + 9}`));
    assert.ok(!pending.some((p) => p.id === 'song-0'));
  } finally {
    await s.close();
  }
});

test('oversized bodies are rejected (not stored)', async () => {
  const s = await withServer();
  try {
    const big = JSON.stringify({ id: 'big', title: 'x'.repeat(MAX_BODY_BYTES + 100) });
    const r = await post(s.base, big).catch(() => ({ status: 0 }));
    assert.notEqual(r.status, 200);
    assert.equal((await getPending(s.base)).length, 0);
  } finally {
    await s.close();
  }
});

test('writes are rate-limited per IP (429 past the window cap)', async () => {
  const s = await withServer({ rateLimitMax: 3, rateLimitWindowMs: 60_000 });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await post(s.base, { id: `rl-${i}`, title: 't' });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally {
    await s.close();
  }
});

test('health endpoint reports the pending count', async () => {
  const s = await withServer();
  try {
    await post(s.base, { id: 'h1', title: 't' });
    const r = await fetch(`${s.base}/requests/health`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.pending, 1);
  } finally {
    await s.close();
  }
});

test('unknown routes return 404', async () => {
  const s = await withServer();
  try {
    const r = await fetch(`${s.base}/nope`);
    assert.equal(r.status, 404);
  } finally {
    await s.close();
  }
});

test('prune drops entries whose song has aired (injected fetch)', async () => {
  const s = await withServer();
  try {
    await post(s.base, { id: 'aired-song', title: 't' });
    await post(s.base, { id: 'still-pending', title: 't' });
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({
        now_playing: { song: { id: 'aired-song' } },
        song_history: [],
      }),
    });
    await s.store.prune(fakeFetch);
    const pending = await getPending(s.base);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'still-pending');
  } finally {
    await s.close();
  }
});

// ---- Contact relay (/contact/*) ---------------------------------------------
//
// Every test injects `fetchImpl`: nothing here ever reaches Discord. The fake
// webhook carries a distinctive token so a leak into a response or a log line
// is easy to spot.

const FAKE_TOKEN = 'tok3n-SHOULD-NEVER-LEAK-9f8e7d';
const FAKE_WEBHOOK = `https://discord.example.invalid/api/webhooks/123456/${FAKE_TOKEN}`;

// A fetch double that records calls and answers with `reply` (a status, or a
// function that throws / returns a response-like object).
function fakeFetch(reply = 204) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    if (typeof reply === 'function') return reply(url, init);
    return { ok: reply >= 200 && reply < 300, status: reply, body: null };
  };
  return { impl, calls };
}

// Captures everything the relay logs.
function captureLog() {
  const lines = [];
  const rec = (...a) => lines.push(a.map(String).join(' '));
  return { log: { warn: rec, log: rec, error: rec, info: rec }, lines };
}

function withContactServer(opts = {}) {
  const { log, lines } = captureLog();
  const fetcher = opts.fetcher ?? fakeFetch();
  const relay = createContactRelay({
    webhookUrl: FAKE_WEBHOOK,
    fetchImpl: fetcher.impl,
    log,
    ...opts.relay,
  });
  const server = createServer(async (req, res) => {
    if (!(await relay.handler(req, res))) {
      res.writeHead(418);
      res.end('not mine');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        relay,
        calls: fetcher.calls,
        logLines: lines,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const contactPost = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const MESSAGE = {
  name: 'Wyatt McKenzie',
  phone: '555-0100',
  profile: 'https://newdayrp.com/members/9631/',
  subject: 'Interview request',
  message: 'Hello!\r\nSecond line @everyone',
};
const EVENT = {
  name: 'Wyatt McKenzie',
  org: 'Vinewood Events',
  phone: '555-0100',
  profile: 'https://newdayrp.com/members/9631/',
  eventName: 'Grand Opening Night',
  eventDate: '2026-10-31',
  startTime: '20:00',
  endTime: '23:00',
  venue: 'The Vinewood Ballroom',
  eventType: 'Club night',
  attendance: '50-100',
  music: 'pop, top 40',
  atmosphere: 'high energy',
  announcements: 'shout the sponsors',
  details: 'Tell us more',
};

// Asserts a response (status line, headers, body text) carries no trace of
// the webhook URL or token.
async function assertNoLeak(r) {
  const text = await r.text();
  const hdrs = JSON.stringify([...r.headers]);
  for (const s of [text, hdrs]) {
    assert.ok(!s.includes(FAKE_TOKEN), 'response leaks the webhook token');
    assert.ok(!s.includes('discord'), 'response mentions the webhook host');
    assert.ok(!s.includes('/api/webhooks/'), 'response leaks the webhook path');
  }
  return text;
}

test('sanitizeMultiline keeps line breaks, strips other control chars, caps length', () => {
  assert.equal(sanitizeMultiline('a\r\nb\rc\n\n\n\nd\u0000e\u0007f\tg', 100), 'a\nb\nc\n\nd e f g');
  assert.equal(sanitizeMultiline('  hi  ', 50), 'hi');
  assert.equal(sanitizeMultiline('abcdef', 3), 'abc');
  assert.equal(sanitizeMultiline(null, 5), '');
});

test('contact: POST /contact/message forwards the contact embed with allowed_mentions off → 204', async () => {
  const s = await withContactServer();
  try {
    const r = await contactPost(s.base, '/contact/message', { ...MESSAGE, name: ' Wyatt\u0000 McKenzie ', extra: 'ignored' });
    assert.equal(r.status, 204);
    assert.equal(await assertNoLeak(r), '');
    assert.equal(s.calls.length, 1);
    const { url, init, payload } = s.calls[0];
    assert.equal(url, FAKE_WEBHOOK);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.ok(init.signal, 'upstream call has a timeout signal');
    assert.deepEqual(Object.keys(payload).sort(), ['allowed_mentions', 'avatar_url', 'embeds', 'thread_name', 'username']);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(payload.username, 'EuphoricFM Contact');
    assert.equal(payload.avatar_url, 'https://euphoric.fm/static/android-chrome-192x192.png');
    assert.equal(payload.thread_name, 'Contact: Interview request');
    assert.equal(payload.embeds.length, 1);
    const e = payload.embeds[0];
    assert.equal(e.title, '📨 New Contact Form Submission');
    assert.equal(e.description, 'A new contact message was submitted from **EuphoricFM** (info.euphoric.fm).');
    assert.equal(e.color, 0xd61c4e);
    assert.deepEqual(e.footer, { text: 'EuphoricFM Contact Form' });
    assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
    assert.deepEqual(e.fields, [
      { name: 'Name', value: 'Wyatt  McKenzie', inline: true },
      { name: 'Subject', value: 'Interview request', inline: true },
      { name: 'Phone', value: '555-0100', inline: true },
      { name: 'NewDayRP Profile', value: 'https://newdayrp.com/members/9631/' },
      { name: 'Message', value: 'Hello!\nSecond line @everyone' },
    ]);
    assert.ok(!JSON.stringify(payload).includes('ignored'), 'unknown keys are dropped');
  } finally {
    await s.close();
  }
});

test('contact: optional fields are left out and a long message is clipped to 1024 like the modal did', async () => {
  const s = await withContactServer();
  try {
    const r = await contactPost(s.base, '/contact/message', { name: 'A', subject: 'S'.repeat(150), message: 'm'.repeat(2000) });
    assert.equal(r.status, 204);
    const { payload } = s.calls[0];
    const names = payload.embeds[0].fields.map((f) => f.name);
    assert.deepEqual(names, ['Name', 'Subject', 'Message']);
    const msg = payload.embeds[0].fields[2].value;
    assert.equal(msg.length, 1022);
    assert.ok(msg.endsWith('…'));
    assert.equal(payload.thread_name.length, 90);
  } finally {
    await s.close();
  }
});

test('contact: POST /contact/event forwards the event-inquiry embed field for field', async () => {
  const s = await withContactServer();
  try {
    const r = await contactPost(s.base, '/contact/event', EVENT);
    assert.equal(r.status, 204);
    const { payload } = s.calls[0];
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(payload.username, 'EuphoricFM Events');
    assert.equal(payload.avatar_url, 'https://euphoric.fm/static/android-chrome-192x192.png');
    assert.equal(payload.thread_name, 'Event Inquiry: Grand Opening Night');
    const e = payload.embeds[0];
    assert.equal(e.title, '📅 EuphoricFM Event Inquiry');
    assert.equal(e.color, 0xfeb139);
    assert.equal(e.description, undefined);
    assert.deepEqual(e.footer, { text: 'EuphoricFM Events Inquiry' });
    assert.deepEqual(e.fields, [
      { name: 'Contact', value: 'Wyatt McKenzie', inline: true },
      { name: 'Phone', value: '555-0100', inline: true },
      { name: 'Organization', value: 'Vinewood Events', inline: true },
      { name: 'NewDayRP Profile', value: 'https://newdayrp.com/members/9631/' },
      { name: 'Event', value: 'Grand Opening Night', inline: true },
      { name: 'Date', value: '2026-10-31', inline: true },
      { name: 'Time', value: '20:00 → 23:00', inline: true },
      { name: 'Venue', value: 'The Vinewood Ballroom', inline: true },
      { name: 'Type', value: 'Club night', inline: true },
      { name: 'Expected Attendance', value: '50-100', inline: true },
      { name: 'Music Style / Genres', value: 'pop, top 40' },
      { name: 'Desired Atmosphere', value: 'high energy' },
      { name: 'Announcements / Promotions', value: 'shout the sponsors' },
      { name: 'Details', value: 'Tell us more' },
    ]);
    // Only one of the two times → that time alone.
    await contactPost(s.base, '/contact/event', { ...EVENT, startTime: '', endTime: '21:00' });
    assert.deepEqual(s.calls[1].payload.embeds[0].fields.find((f) => f.name === 'Time'), { name: 'Time', value: '21:00', inline: true });
  } finally {
    await s.close();
  }
});

test('contact: invalid submissions are rejected 400 and never forwarded', async () => {
  const s = await withContactServer({ relay: { rateLimitMax: 1000 } });
  try {
    const cases = [
      ['/contact/message', { ...MESSAGE, name: '' }, 'name'],
      ['/contact/message', { ...MESSAGE, subject: '  \u0000\u0001 ' }, 'subject'], // control chars only → empty
      ['/contact/message', { ...MESSAGE, message: undefined }, 'message'],
      ['/contact/message', { ...MESSAGE, name: 'n'.repeat(101) }, 'name'],
      ['/contact/message', { ...MESSAGE, message: 'm'.repeat(4001) }, 'message'],
      ['/contact/message', { ...MESSAGE, subject: { $gt: '' } }, 'subject'],
      ['/contact/message', { ...MESSAGE, phone: 12345 }, 'phone'],
      ['/contact/message', { ...MESSAGE, profile: 'https://evil.example/members/1/' }, 'profile'],
      ['/contact/event', { ...EVENT, venue: '' }, 'venue'],
      ['/contact/event', { ...EVENT, eventDate: '' }, 'eventDate'],
      ['/contact/event', { ...EVENT, details: 'd'.repeat(4001) }, 'details'],
    ];
    for (const [path, body, field] of cases) {
      const r = await contactPost(s.base, path, body);
      assert.equal(r.status, 400, `${path} ${field}`);
      const j = JSON.parse(await assertNoLeak(r));
      assert.equal(j.field, field);
    }
    for (const raw of ['not json', '[1,2]', 'null', '"str"']) {
      const r = await contactPost(s.base, '/contact/message', raw);
      assert.equal(r.status, 400, raw);
    }
    // A form-encoded (non-JSON) post is refused, so a cross-site <form> can't drive it.
    const form = await fetch(`${s.base}/contact/message`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(MESSAGE),
    });
    assert.equal(form.status, 400);
    assert.equal(s.calls.length, 0, 'nothing reached the webhook');
    // Submitted text never lands in a log line (JSON.parse errors quote input).
    assert.ok(!s.logLines.some((l) => l.includes('not json') || l.includes('Wyatt')));
  } finally {
    await s.close();
  }
});

test('contact: bodies over the cap get 413 and are not forwarded', async () => {
  const s = await withContactServer({ relay: { rateLimitMax: 1000 } });
  try {
    // With a Content-Length (fetch).
    const big = JSON.stringify({ ...MESSAGE, message: 'x'.repeat(CONTACT_MAX_BODY_BYTES) });
    const r = await contactPost(s.base, '/contact/message', big);
    assert.equal(r.status, 413);
    await assertNoLeak(r);
    // Chunked, no Content-Length: the cap trips mid-stream.
    const status = await new Promise((resolve, reject) => {
      const u = new URL(`${s.base}/contact/event`);
      const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      const chunk = 'y'.repeat(4096);
      req.write('{"details":"');
      for (let i = 0; i < 8; i++) req.write(chunk);
      req.end('"}');
    });
    assert.equal(status, 413);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test(`contact: ${CONTACT_RATE_LIMIT_MAX} sends per IP per ${CONTACT_RATE_LIMIT_WINDOW_MS / 60_000} min, shared by both forms, then 429`, async () => {
  let clock = 1_000_000;
  const s = await withContactServer({ relay: { now: () => clock } });
  try {
    const ip = { 'x-forwarded-for': '10.9.9.9, 203.0.113.50' };
    const codes = [];
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX + 2; i++) {
      const path = i % 2 ? '/contact/event' : '/contact/message';
      const r = await contactPost(s.base, path, i % 2 ? EVENT : MESSAGE, { ...ip, 'x-forwarded-for': `10.0.0.${i}, 203.0.113.50` });
      codes.push(r.status);
      if (r.status === 429) {
        assert.equal(r.headers.get('retry-after'), String(CONTACT_RATE_LIMIT_WINDOW_MS / 1000));
        assert.equal(JSON.parse(await assertNoLeak(r)).retry_after, CONTACT_RATE_LIMIT_WINDOW_MS / 1000);
      }
    }
    assert.deepEqual(codes, [...Array(CONTACT_RATE_LIMIT_MAX).fill(204), 429, 429]);
    assert.equal(s.calls.length, CONTACT_RATE_LIMIT_MAX);
    // Another client is unaffected.
    assert.equal((await contactPost(s.base, '/contact/message', MESSAGE, { 'x-forwarded-for': '198.51.100.7' })).status, 204);
    // The window rolls over.
    clock += CONTACT_RATE_LIMIT_WINDOW_MS;
    assert.equal((await contactPost(s.base, '/contact/message', MESSAGE, ip)).status, 204);
  } finally {
    await s.close();
  }
});

test('contact: an upstream failure (HTTP error, network error, timeout) is a 502 that leaks nothing', async () => {
  const replies = [
    // Discord answering with an error that echoes the URL must not be passed on.
    async (url) => ({ ok: false, status: 404, body: null, text: async () => `unknown webhook ${url}` }),
    async () => ({ ok: false, status: 429, body: null }),
    async (url) => { throw new TypeError(`fetch failed for ${url}`); },
    async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
  ];
  for (const reply of replies) {
    const fetcher = fakeFetch(reply);
    const s = await withContactServer({ fetcher, relay: { rateLimitMax: 1000 } });
    try {
      const r = await contactPost(s.base, '/contact/message', MESSAGE);
      assert.equal(r.status, 502);
      await assertNoLeak(r);
      assert.equal(fetcher.calls.length, 1);
      assert.ok(s.logLines.some((l) => l.includes('[efm-contact] upstream')), 'failure is logged');
      for (const l of s.logLines) {
        assert.ok(!l.includes(FAKE_TOKEN) && !l.includes('/api/webhooks/'), `log leaks the webhook: ${l}`);
        assert.ok(!l.includes('Wyatt') && !l.includes('Interview'), `log leaks the submission: ${l}`);
      }
    } finally {
      await s.close();
    }
  }
});

test('contact: DISCORD_CONTACT_WEBHOOK unset (or not https) → 503 with a clear log line', async () => {
  const saved = process.env.DISCORD_CONTACT_WEBHOOK;
  try {
    delete process.env.DISCORD_CONTACT_WEBHOOK;
    for (const relayOpts of [{}, { webhookUrl: '' }, { webhookUrl: 'http://discord.example.invalid/api/webhooks/1/' + FAKE_TOKEN }]) {
      const fetcher = fakeFetch();
      const { log, lines } = captureLog();
      const relay = createContactRelay({ fetchImpl: fetcher.impl, log, ...relayOpts });
      assert.equal(relay.enabled, false);
      const server = createServer((req, res) => relay.handler(req, res));
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        const r = await contactPost(`http://127.0.0.1:${server.address().port}`, '/contact/message', MESSAGE);
        assert.equal(r.status, 503);
        await assertNoLeak(r);
        assert.equal(fetcher.calls.length, 0);
        assert.ok(lines.some((l) => /relay disabled: DISCORD_CONTACT_WEBHOOK/.test(l)), 'startup says why');
        assert.ok(lines.some((l) => /503 message: DISCORD_CONTACT_WEBHOOK/.test(l)), 'the request is logged');
        assert.ok(!lines.some((l) => l.includes(FAKE_TOKEN)), 'log never prints the value');
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
    // Set in the environment → used from there.
    process.env.DISCORD_CONTACT_WEBHOOK = FAKE_WEBHOOK;
    const fetcher = fakeFetch();
    const relay = createContactRelay({ fetchImpl: fetcher.impl, log: captureLog().log });
    assert.equal(relay.enabled, true);
  } finally {
    if (saved === undefined) delete process.env.DISCORD_CONTACT_WEBHOOK;
    else process.env.DISCORD_CONTACT_WEBHOOK = saved;
  }
});

test('contact: only POST on the two form paths; other /contact paths 404/405, the rest falls through', async () => {
  const s = await withContactServer();
  try {
    const get = await fetch(`${s.base}/contact/message`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    await assertNoLeak(get);
    assert.equal((await contactPost(s.base, '/contact/nope', MESSAGE)).status, 404);
    assert.equal((await contactPost(s.base, '/contact/message/', MESSAGE)).status, 404);
    // Query strings don't change the route.
    assert.equal((await contactPost(s.base, '/contact/message?x=1', MESSAGE)).status, 204);
    // Not under /contact/ → not handled by the relay.
    assert.equal((await fetch(`${s.base}/requests/pending`)).status, 418);
    assert.equal((await fetch(`${s.base}/contactx`)).status, 418);
    assert.equal(s.calls.length, 1);
  } finally {
    await s.close();
  }
});
