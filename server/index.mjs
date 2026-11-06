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
//   GET  /stats/*           -> full-time station stats — see stats.mjs (its
//                              own header documents the routes in full)
//   POST /contact/message   -> "Contact us" form → Discord webhook  → 204
//   POST /contact/event     -> /events inquiry form → Discord webhook → 204
//                              (see "Contact relay" below)
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
// The contact relay exists so the Discord webhook URL (id + token) never
// leaves this container: it used to be rendered into a public script, and
// anyone holding it can post as the webhook, rename it or delete it. The URL
// comes from DISCORD_CONTACT_WEBHOOK at runtime only and is never logged or
// echoed; visitors send plain form fields, and this service builds the embed.
//
// Zero deps: node:http + node:fs + global fetch (Node 22+/24).

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStats } from './stats.mjs';

export const TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ENTRIES = 50;
export const PRUNE_INTERVAL_MS = 30_000;
export const STATS_TICK_INTERVAL_MS = 30_000;
export const BACKFILL_STEP_INTERVAL_MS = 15_000;
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

// Multi-line free text (the contact message / event details): the same
// control-char strip as sanitizeText, except line breaks survive (CRLF/CR are
// normalised to LF, runs of blank lines collapse to one) so a message keeps
// its paragraphs in Discord.
export const sanitizeMultiline = (raw, max) =>
  String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
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

// Fixed-window per-IP limiter. hit(ip) counts one request and reports whether
// it is over the cap, plus how many seconds are left in the window.
export function createRateLimiter({ max, windowMs, now = Date.now }) {
  const buckets = new Map(); // ip -> { count, resetAt }
  const hit = (ip) => {
    const t = now();
    if (buckets.size > MAX_RATE_BUCKETS) {
      for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
    }
    let b = buckets.get(ip);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(ip, b);
    }
    b.count += 1;
    return {
      limited: b.count > max,
      retryAfterS: Math.max(1, Math.ceil((b.resetAt - t) / 1000)),
    };
  };
  return { hit };
}

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
  const limiter = createRateLimiter({ max: rateMax, windowMs: rateWindow });
  const rateLimited = (ip) => limiter.hit(ip).limited;

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

// ---- Contact relay (/contact/*) --------------------------------------------
//
// The "Contact us" modal and the /events inquiry modal POST their form fields
// here as JSON; this service validates them, builds the same Discord embed the
// modals used to build in the browser, and forwards it to the webhook in
// DISCORD_CONTACT_WEBHOOK. Status codes: 204 sent, 400 invalid, 413 body too
// large, 429 rate limited (Retry-After set), 502 Discord failed or timed out,
// 503 the webhook is not configured.
//
// SECURITY: the webhook URL is a bearer credential (execute / rename / delete).
// It is read from the environment at runtime, never baked into an image, and
// never written to a log line or a response. Log lines name only the form kind
// and an HTTP status or error name; submitted fields are never logged either
// (JSON.parse errors quote the input, so parse failures are not logged at all).
// Outgoing messages set allowed_mentions {parse: []}, so nothing a visitor
// types can ping anyone. Writes are limited per client IP (clientIp(): the
// rightmost X-Forwarded-For, set by our Caddy) with their own, stricter bucket.

export const CONTACT_MAX_BODY_BYTES = 16 * 1024;
// Past this many bytes the upload is cut off instead of drained.
const CONTACT_DRAIN_CEILING_BYTES = 256 * 1024;
export const CONTACT_RATE_LIMIT_MAX = 5;
export const CONTACT_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
export const CONTACT_UPSTREAM_TIMEOUT_MS = 10_000;
// Mirrors of src/site.config.ts (discord.avatarUrl, name,
// newDayRpProfilePattern). This image cannot import the site source, so
// test/site-build.test.mjs asserts the two stay equal.
export const CONTACT_AVATAR_URL = 'https://euphoric.fm/static/android-chrome-192x192.png';
export const CONTACT_STATION_NAME = 'EuphoricFM';
export const NEWDAYRP_PROFILE_PATTERN = '^https?://(www\\.)?newdayrp\\.com/members/\\d+/?$';
const PROFILE_RE = new RegExp(NEWDAYRP_PROFILE_PATTERN, 'i');

// Per-form field rules. `max` is checked after control chars are stripped and
// the value trimmed; anything longer is rejected (400), not silently cut.
// Discord caps an embed field value at 1024 chars, so the long free-text
// fields are clipped for the embed exactly as the modals did (clip1024).
const MESSAGE_FIELDS = {
  name: { max: 100, required: true },
  phone: { max: 40 },
  profile: { max: 200, profile: true },
  subject: { max: 200, required: true },
  message: { max: 4000, required: true, multiline: true },
};
const EVENT_FIELDS = {
  name: { max: 100, required: true },
  org: { max: 100 },
  phone: { max: 40 },
  profile: { max: 200, profile: true },
  eventName: { max: 150, required: true },
  eventDate: { max: 40, required: true },
  startTime: { max: 20 },
  endTime: { max: 20 },
  venue: { max: 150, required: true },
  eventType: { max: 80 },
  attendance: { max: 100 },
  music: { max: 300 },
  atmosphere: { max: 300 },
  announcements: { max: 500 },
  details: { max: 4000, required: true, multiline: true },
};

// Returns { fields } or { error, field }.
export const validateContactFields = (body, spec) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid body' };
  }
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    const raw = Object.hasOwn(body, key) ? body[key] : undefined;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      return { error: 'invalid', field: key };
    }
    const clean = rule.multiline
      ? sanitizeMultiline(raw, rule.max + 1)
      : sanitizeText(raw, rule.max + 1);
    if (clean.length > rule.max) return { error: 'too long', field: key };
    if (rule.required && !clean) return { error: 'required', field: key };
    if (rule.profile && clean && !PROFILE_RE.test(clean)) return { error: 'invalid', field: key };
    out[key] = clean;
  }
  return { fields: out };
};

const clip1024 = (s) => (s.length > 1024 ? s.slice(0, 1021) + '…' : s);

// Field-for-field the payload ContactModal.astro built in the browser before
// v0.22.3, plus allowed_mentions.
export const buildContactMessagePayload = (f, now = new Date()) => {
  const fields = [
    { name: 'Name', value: f.name, inline: true },
    { name: 'Subject', value: f.subject, inline: true },
  ];
  if (f.phone) fields.push({ name: 'Phone', value: f.phone, inline: true });
  if (f.profile) fields.push({ name: 'NewDayRP Profile', value: f.profile });
  fields.push({ name: 'Message', value: clip1024(f.message) });
  return {
    username: 'EuphoricFM Contact',
    avatar_url: CONTACT_AVATAR_URL,
    thread_name: `Contact: ${f.subject}`.slice(0, 90),
    embeds: [{
      title: '📨 New Contact Form Submission',
      description: `A new contact message was submitted from **${CONTACT_STATION_NAME}** (info.euphoric.fm).`,
      color: 0xd61c4e,
      fields,
      timestamp: now.toISOString(),
      footer: { text: 'EuphoricFM Contact Form' },
    }],
    allowed_mentions: { parse: [] },
  };
};

// Field-for-field the payload EventInquiryModal.astro built in the browser
// before v0.22.3, plus allowed_mentions.
export const buildEventInquiryPayload = (f, now = new Date()) => {
  const fields = [{ name: 'Contact', value: f.name, inline: true }];
  if (f.phone) fields.push({ name: 'Phone', value: f.phone, inline: true });
  if (f.org) fields.push({ name: 'Organization', value: f.org, inline: true });
  if (f.profile) fields.push({ name: 'NewDayRP Profile', value: f.profile });
  fields.push({ name: 'Event', value: f.eventName, inline: true });
  fields.push({ name: 'Date', value: f.eventDate, inline: true });
  if (f.startTime || f.endTime) {
    const timeValue = f.startTime && f.endTime ? `${f.startTime} → ${f.endTime}` : (f.startTime || f.endTime);
    fields.push({ name: 'Time', value: timeValue, inline: true });
  }
  fields.push({ name: 'Venue', value: f.venue, inline: true });
  if (f.eventType) fields.push({ name: 'Type', value: f.eventType, inline: true });
  if (f.attendance) fields.push({ name: 'Expected Attendance', value: f.attendance, inline: true });
  if (f.music) fields.push({ name: 'Music Style / Genres', value: f.music });
  if (f.atmosphere) fields.push({ name: 'Desired Atmosphere', value: f.atmosphere });
  if (f.announcements) fields.push({ name: 'Announcements / Promotions', value: f.announcements });
  fields.push({ name: 'Details', value: clip1024(f.details) });
  return {
    username: 'EuphoricFM Events',
    avatar_url: CONTACT_AVATAR_URL,
    thread_name: `Event Inquiry: ${f.eventName}`.slice(0, 90),
    embeds: [{
      title: '📅 EuphoricFM Event Inquiry',
      color: 0xfeb139,
      fields,
      timestamp: now.toISOString(),
      footer: { text: 'EuphoricFM Events Inquiry' },
    }],
    allowed_mentions: { parse: [] },
  };
};

const CONTACT_FORMS = {
  '/contact/message': { kind: 'message', spec: MESSAGE_FIELDS, build: buildContactMessagePayload },
  '/contact/event': { kind: 'event', spec: EVENT_FIELDS, build: buildEventInquiryPayload },
};

const isHttpsUrl = (s) => {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
};

// Reads at most maxBytes of the body. Past that it resolves { tooLarge } at
// once (the caller answers 413) and keeps discarding the rest so the client
// can read the reply; past CONTACT_DRAIN_CEILING_BYTES it cuts the upload off.
const readLimitedBody = (req, maxBytes) =>
  new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > CONTACT_DRAIN_CEILING_BYTES) {
      resolve({ tooLarge: true, cutOff: true });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const settle = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > CONTACT_DRAIN_CEILING_BYTES) req.destroy();
      if (settled) return;
      if (bytes > maxBytes || (Number.isFinite(declared) && declared > maxBytes)) {
        chunks.length = 0;
        settle({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle({ raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ aborted: true }));
    req.on('close', () => settle({ aborted: true }));
  });

export function createContactRelay(opts = {}) {
  const webhookUrl = String(
    Object.hasOwn(opts, 'webhookUrl') ? opts.webhookUrl ?? '' : process.env.DISCORD_CONTACT_WEBHOOK ?? '',
  ).trim();
  const fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  const log = opts.log ?? console;
  const maxBodyBytes = opts.maxBodyBytes ?? CONTACT_MAX_BODY_BYTES;
  const timeoutMs = opts.upstreamTimeoutMs ?? CONTACT_UPSTREAM_TIMEOUT_MS;
  const limiter = createRateLimiter({
    max: opts.rateLimitMax ?? CONTACT_RATE_LIMIT_MAX,
    windowMs: opts.rateLimitWindowMs ?? CONTACT_RATE_LIMIT_WINDOW_MS,
    now: opts.now,
  });

  // Never print the value, only whether it is usable.
  let disabledReason = '';
  if (!webhookUrl) disabledReason = 'DISCORD_CONTACT_WEBHOOK is not set';
  else if (!isHttpsUrl(webhookUrl)) disabledReason = 'DISCORD_CONTACT_WEBHOOK is not an https URL';
  if (disabledReason) log.warn(`[efm-contact] relay disabled: ${disabledReason} — /contact/* answers 503`);

  const send = (res, code, body, extra = {}) => {
    const headers = { 'cache-control': 'no-store', ...extra };
    if (body === undefined) {
      res.writeHead(code, headers);
      res.end();
      return;
    }
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  // Returns true when it answered the request (anything under /contact/).
  const handler = async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path !== '/contact' && !path.startsWith('/contact/')) return false;
    const form = Object.hasOwn(CONTACT_FORMS, path) ? CONTACT_FORMS[path] : null;
    if (!form) {
      send(res, 404, { error: 'not found' });
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
      return true;
    }

    const rate = limiter.hit(clientIp(req));
    if (rate.limited) {
      send(res, 429, { error: 'rate limited', retry_after: rate.retryAfterS }, {
        'retry-after': String(rate.retryAfterS),
      });
      return true;
    }
    if (disabledReason) {
      log.warn(`[efm-contact] 503 ${form.kind}: ${disabledReason}`);
      send(res, 503, { error: 'contact form not configured' });
      return true;
    }
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!/^application\/json\s*(;|$)/.test(ctype)) {
      send(res, 400, { error: 'expected application/json' });
      return true;
    }

    const got = await readLimitedBody(req, maxBodyBytes);
    if (got.aborted) return true;
    if (got.tooLarge) {
      // No `connection: close`: the socket stays open while readLimitedBody
      // discards the rest of the upload, so the client gets to read the 413.
      send(res, 413, { error: 'payload too large' });
      if (got.cutOff) req.destroy();
      return true;
    }
    let body;
    try {
      body = JSON.parse(got.raw || '');
    } catch {
      send(res, 400, { error: 'invalid json' });
      return true;
    }
    const v = validateContactFields(body, form.spec);
    if (v.error) {
      send(res, 400, v.field ? { error: v.error, field: v.field } : { error: v.error });
      return true;
    }

    try {
      const r = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form.build(v.fields)),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Never read or pass on Discord's reply body; just release it.
      try { await r.body?.cancel?.(); } catch { /* ignore */ }
      if (!r.ok) {
        log.warn(`[efm-contact] upstream rejected ${form.kind}: HTTP ${r.status}`);
        send(res, 502, { error: 'upstream failed' });
        return true;
      }
    } catch (e) {
      // e.name only: an undici error message/cause can carry the request URL.
      log.warn(`[efm-contact] upstream error ${form.kind}: ${e?.name || 'Error'}`);
      send(res, 502, { error: 'upstream failed' });
      return true;
    }
    send(res, 204);
    return true;
  };

  return { handler, enabled: !disabledReason };
}

// ---- Entrypoint ------------------------------------------------------------

export function main() {
  const PORT = Number(process.env.PORT || 3000);
  const store = createStore();
  const stats = createStats({ sanitizeText, sanitizeArt });
  const contact = createContactRelay();
  // stats.handler returns false for anything that isn't a known GET /stats
  // route and contact.handler for anything outside /contact/, so
  // store.handler's own 404 remains the terminal fallthrough.
  // store.handler is async — fine to call without await here, matching its
  // existing (pre-stats) usage as the raw createServer callback.
  const server = createServer(async (req, res) => {
    if (await stats.handler(req, res)) return;
    try {
      if (await contact.handler(req, res)) return;
    } catch (e) {
      // Name only — never the message (it could quote submitted fields).
      console.warn('[efm-contact] handler error:', e?.name || 'Error');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'server error' }));
      }
      return;
    }
    return store.handler(req, res);
  });

  const interval = setInterval(() => store.prune(), PRUNE_INTERVAL_MS);
  store.prune();

  const statsInterval = setInterval(() => stats.tick(), STATS_TICK_INTERVAL_MS);
  stats.tick();

  // Backfill drives itself with a self-rescheduling setTimeout chain (never
  // a bare setInterval) so the next step is only scheduled once the previous
  // one has fully settled — see the re-entrancy guard in stats.mjs. Only
  // started when an API key is configured; with no key backfill is a no-op
  // forever and there is nothing to schedule.
  let backfillTimer = null;
  if (process.env.AZURACAST_API_KEY) {
    const scheduleBackfillStep = () => {
      backfillTimer = setTimeout(async () => {
        let more = true;
        try {
          more = await stats.backfillStep();
        } catch (e) {
          console.warn('[efm-stats] backfill step failed:', e.message);
        }
        if (more) scheduleBackfillStep();
      }, BACKFILL_STEP_INTERVAL_MS);
    };
    scheduleBackfillStep();
  }

  // Graceful shutdown: flush both stores and stop accepting connections so a
  // Watchtower-driven redeploy doesn't drop in-flight writes or leak timers.
  const shutdown = (sig) => {
    console.log(`[efm-requests] ${sig} — shutting down`);
    clearInterval(interval);
    clearInterval(statsInterval);
    if (backfillTimer) clearTimeout(backfillTimer);
    store.save();
    stats.save();
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
