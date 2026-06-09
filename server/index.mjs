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
// SECURITY: /requests/track is public + unauthenticated, so every field is
// attacker-controlled. We (1) sanitise `art` to a plain http(s)/relative URL
// (it is rendered into <img src="…"> client-side, so an un-sanitised value
// like `x" onerror="…` would be stored XSS), (2) strip control chars from the
// free-text fields, and (3) rate-limit writes per client IP. The client also
// HTML-escapes these on render — defence in depth.
//
// Zero deps: node:http + node:fs + global fetch (Node 22+/24).

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ENTRIES = 50;
export const PRUNE_INTERVAL_MS = 30_000;
export const MAX_BODY_BYTES = 4096;
// Fixed-window write rate limit, keyed on client IP (see clientIp()).
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 20;
// Cap on the per-IP bucket map so a flood of distinct source IPs can't grow
// it unbounded; expired windows are swept once it exceeds this.
const MAX_RATE_BUCKETS = 10_000;

// ---- Field sanitisers ------------------------------------------------------

// `art` is rendered into <img src="…"> on every visitor's page. Allow only an
// absolute http(s) URL or a root-relative path, and reject anything with
// quote/space/angle-bracket/backslash chars that could break out of the
// attribute. Everything else collapses to '' (the client shows a placeholder).
export const sanitizeArt = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 500) return '';
  if (s.startsWith('/') && !s.startsWith('//')) {
    return /[\s"'<>\\`]/.test(s) ? '' : s;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href.length <= 500 ? u.href : '';
  } catch {
    return '';
  }
};

// Free-text fields: drop control chars (incl. newlines) and cap length.
export const sanitizeText = (raw, max) =>
  String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

// Client IP for the rate limiter. We trust X-Forwarded-For only because this
// service has no host port binding and is reachable solely via our own Caddy
// (which sets it from the real {remote_host} — see the /requests/* block in the
// Caddyfile). Take the RIGHTMOST entry: that is the hop our Caddy
// appended/set, so a client-supplied XFF prefix (e.g. a unique value per
// request to dodge the limiter) cannot spoof it. Falls back to the socket peer.
export const clientIp = (req) => {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
};

// ---- Store factory (no side effects on import — see invokedDirectly guard) --

export function createStore(opts = {}) {
  const STORE = opts.storePath || process.env.STORE_PATH || '/data/pending.json';
  const NOWPLAYING_URL =
    opts.nowplayingUrl ||
    process.env.NOWPLAYING_URL ||
    'https://euphoric.fm/api/nowplaying/euphoricfm';
  const rateMax = opts.rateLimitMax ?? (Number(process.env.RATE_LIMIT_MAX) || RATE_LIMIT_MAX);
  const rateWindow = opts.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;

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

  // fetchImpl is injectable so tests can drive pruning deterministically.
  const prune = async (fetchImpl = fetch) => {
    try {
      const r = await fetchImpl(NOWPLAYING_URL, { cache: 'no-store' });
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

  // Fixed-window per-IP limiter for the write endpoint.
  const buckets = new Map(); // ip -> { count, resetAt }
  const rateLimited = (ip) => {
    const now = Date.now();
    if (buckets.size > MAX_RATE_BUCKETS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    let b = buckets.get(ip);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + rateWindow };
      buckets.set(ip, b);
    }
    b.count += 1;
    return b.count > rateMax;
  };

  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0;
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error('payload too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
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

  const handler = async (req, res) => {
    try {
      const url = req.url || '/';
      if (req.method === 'GET' && url === '/requests/pending') {
        return respond(res, 200, pending);
      }
      if (req.method === 'GET' && url === '/requests/health') {
        return respond(res, 200, { ok: true, pending: pending.length });
      }
      if (req.method === 'POST' && url === '/requests/track') {
        if (rateLimited(clientIp(req))) {
          return respond(res, 429, { error: 'rate limited' });
        }
        const body = await readJsonBody(req);
        // Sanitise the id up front so dedupe + prune compare against the exact
        // value we store (otherwise a control char or >64-char id would be
        // stored truncated but deduped against the raw value → duplicates).
        const id = typeof body?.id === 'string' ? sanitizeText(body.id, 64) : '';
        if (!id) {
          return respond(res, 400, { error: 'id required' });
        }
        const now = Date.now();
        // Dedupe (same id resubmitted) and TTL-evict in one pass.
        pending = pending.filter(
          (p) => p.id !== id && now - (p.ts || 0) < TTL_MS,
        );
        pending.push({
          id,
          title: sanitizeText(body.title, 200),
          artist: sanitizeText(body.artist, 200),
          art: sanitizeArt(body.art),
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
  };

  return { handler, prune, save };
}

// ---- Entrypoint ------------------------------------------------------------

export function main() {
  const PORT = Number(process.env.PORT || 3000);
  const store = createStore();
  const server = createServer(store.handler);

  const interval = setInterval(() => store.prune(), PRUNE_INTERVAL_MS);
  store.prune();

  // Graceful shutdown: flush the store and stop accepting connections so a
  // Watchtower-driven redeploy doesn't drop in-flight writes or leak the timer.
  const shutdown = (sig) => {
    console.log(`[efm-requests] ${sig} — shutting down`);
    clearInterval(interval);
    store.save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, () => {
    console.log(`[efm-requests] :${PORT} ttl=${TTL_MS}ms`);
  });
  return { server, store, interval };
}

// Only run as a server when invoked directly (`node index.mjs`, absolute or
// relative path); importing the module (tests) gets the factory + sanitisers
// with zero side effects. resolve() normalises a relative argv[1] to match the
// absolute module path.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();
