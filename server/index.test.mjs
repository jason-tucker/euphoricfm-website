// Tests for the efm-requests shared pending-requests service.
//
// Run: `node --test server/` (built-in node:test, zero deps). The module is
// imported for its factory + sanitisers — importing has no side effects (no
// listen, no timers), see the invokedDirectly guard in index.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createStore,
  sanitizeArt,
  sanitizeText,
  clientIp,
  MAX_ENTRIES,
  MAX_BODY_BYTES,
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
