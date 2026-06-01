// efm-requests — tiny shared pending-requests store for info.euphoric.fm.
//
// AzuraCast's actual request-queue endpoint is auth-only, so the original
// "Your Requests" sidebar (v0.6.0) used localStorage and was per-browser.
// This service moves that state server-side so every visitor sees every
// pending request, not just the ones they themselves submitted.
//
// Endpoints
//   GET  /requests/pending  -> JSON array of {id, title, artist, art, ts}
//   POST /requests/track    -> body {id, title, artist, art} → 200 {ok:true}
//   GET  /requests/health   -> 200 {ok:true, pending:n}
//
// Pruning runs every 30s: polls AzuraCast /api/nowplaying/<station> and
// drops any pending entry whose `song.id` appears in now_playing.song.id or
// song_history[].song.id (the track aired). A 6h TTL evicts stragglers that
// AzuraCast silently rejected. The list is capped at 50 entries on writes
// so localStorage-style abuse can't grow the file unbounded.
//
// Zero deps: node:http + node:fs + global fetch (Node 24).

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const STORE = process.env.STORE_PATH || '/data/pending.json';
const NOWPLAYING_URL =
  process.env.NOWPLAYING_URL || 'https://euphoric.fm/api/nowplaying/euphoricfm';
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;
const PRUNE_INTERVAL_MS = 30_000;
const MAX_BODY_BYTES = 4096;

mkdirSync(dirname(STORE), { recursive: true });

let pending = [];
try {
  if (existsSync(STORE)) {
    const raw = JSON.parse(readFileSync(STORE, 'utf8'));
    pending = Array.isArray(raw) ? raw : [];
  }
} catch (e) {
  console.warn('[efm-requests] load failed:', e.message);
  pending = [];
}

const save = () => {
  try {
    writeFileSync(STORE, JSON.stringify(pending));
  } catch (e) {
    console.warn('[efm-requests] save failed:', e.message);
  }
};

const prune = async () => {
  try {
    const r = await fetch(NOWPLAYING_URL, { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    const aired = new Set();
    if (data?.now_playing?.song?.id) aired.add(data.now_playing.song.id);
    for (const h of data?.song_history ?? []) {
      if (h?.song?.id) aired.add(h.song.id);
    }
    const now = Date.now();
    const before = pending.length;
    pending = pending.filter(
      (p) => p && p.id && !aired.has(p.id) && now - (p.ts || 0) < TTL_MS,
    );
    if (pending.length !== before) save();
  } catch (e) {
    console.warn('[efm-requests] prune failed:', e.message);
  }
};

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });

const respond = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    if (req.method === 'GET' && url === '/requests/pending') {
      return respond(res, 200, pending);
    }
    if (req.method === 'GET' && url === '/requests/health') {
      return respond(res, 200, { ok: true, pending: pending.length });
    }
    if (req.method === 'POST' && url === '/requests/track') {
      const body = await readJsonBody(req);
      if (!body || typeof body.id !== 'string' || !body.id) {
        return respond(res, 400, { error: 'id required' });
      }
      const now = Date.now();
      // Dedupe (same id resubmitted) and TTL-evict in one pass.
      pending = pending.filter(
        (p) => p.id !== body.id && now - (p.ts || 0) < TTL_MS,
      );
      pending.push({
        id: body.id.slice(0, 64),
        title: String(body.title || '').slice(0, 200),
        artist: String(body.artist || '').slice(0, 200),
        art: String(body.art || '').slice(0, 500),
        ts: now,
      });
      while (pending.length > MAX_ENTRIES) pending.shift();
      save();
      return respond(res, 200, { ok: true, pending: pending.length });
    }
    respond(res, 404, { error: 'not found' });
  } catch (e) {
    console.warn('[efm-requests] handler error:', e.message);
    respond(res, 500, { error: 'server error' });
  }
});

setInterval(prune, PRUNE_INTERVAL_MS);
prune();

server.listen(PORT, () => {
  console.log(`[efm-requests] :${PORT} store=${STORE} ttl=${TTL_MS}ms`);
});
