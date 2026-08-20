// efm-stats — full-time station stats aggregation for info.euphoric.fm.
//
// AzuraCast's public API only exposes /api/nowplaying/<station> (current
// song, listener count, ~15 history entries). The auth-only history API
// (/api/station/<station>/history, header X-API-Key) is what lets us
// reconstruct the station's FULL play history back to founding. This module
// therefore ingests plays from three streams that must stay mutually
// idempotent even though they overlap and race:
//
//   1. live nowplaying poll (every 30s, no key needed) — the FORWARD stream.
//   2. syncRecent (needs a key) — re-fetches a window around "now" every
//      10 min to fill any gap the 30s poll missed (deploys, downtime). Also
//      a FORWARD stream — it shares the same watermark as (1).
//   3. backfill (needs a key) — walks 7-day windows from STATS_BACKFILL_START
//      up to a ONE-TIME-FROZEN boundary, filling everything OLDER than what
//      the forward streams cover. Runs independently of the watermark so it
//      can never race the forward region.
//
// Graceful degradation is load-bearing: with no key, streams 2 and 3 are
// simply disabled and (1) still accumulates stats from first boot. With no
// key OR a broken one, live ingest must not stay blocked forever (see the
// syncFailures escape hatch in ingestNowPlaying) — a bad key must not be
// able to silently disable stats.
//
// Zero deps: node:fs + node:path + global fetch (Node 22+/24). No side
// effects at import — createStats() is a factory, mirroring index.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;
export const MAX_TRACKS = 10_000;
export const MIN5_CAP = 576; // 48h of 5-min buckets
export const HOURLY_CAP = 720; // 30d of 1h buckets
export const SYNC_INTERVAL_MS = 10 * 60 * 1000;
export const BACKFILL_WINDOW_DAYS = 7;
export const BACKFILL_MAX_PAGES = 50;
export const CACHE_TTL_MS = 30_000;
export const SAVE_INTERVAL_MS = 60_000;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 120;
const MAX_RATE_BUCKETS = 10_000;
const MAX_DAY_POINTS = 4200; // safety valve — trims oldest, see spec

// ---- small pure helpers -----------------------------------------------------

const round1 = (n) => Math.round(n * 10) / 10;

const isValidRow = (row) =>
  !!row &&
  Number.isFinite(Number(row.played_at)) &&
  Number(row.played_at) > 0 &&
  typeof row?.song?.id === 'string' &&
  row.song.id.length > 0;

// Rows may arrive unsorted (out-of-order poll batches, over-returning API) —
// every stream must sort ascending before gating so the watermark comparison
// below is meaningful.
const sortRows = (rows) =>
  rows.slice().sort((a, b) => {
    const pa = Number(a?.played_at) || 0;
    const pb = Number(b?.played_at) || 0;
    if (pa !== pb) return pa - pb;
    return (Number(a?.sh_id) || 0) - (Number(b?.sh_id) || 0);
  });

// Plain UTC date-string math — calendar iteration between two 'YYYY-MM-DD'
// keys needs no timezone involvement, only dateParts() (below) does.
const addDaysToISODate = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

// ---- factory -----------------------------------------------------------------

export function createStats(opts = {}) {
  const STORE_PATH = opts.storePath || process.env.STATS_STORE_PATH || '/data/stats.json';
  const API_BASE = opts.apiBase || process.env.AZURACAST_API_BASE || 'https://euphoric.fm/api';
  const STATION_ID = opts.stationId || process.env.STATION_ID || 'euphoricfm';
  const API_KEY = opts.apiKey ?? process.env.AZURACAST_API_KEY ?? '';
  const BACKFILL_START = opts.backfillStart || process.env.STATS_BACKFILL_START || '2023-01-01';
  const TZ = opts.timezone || process.env.STATS_TZ || 'America/New_York';
  const RESET_TOKEN = opts.backfillReset ?? process.env.STATS_BACKFILL_RESET ?? '';
  const clock = typeof opts.now === 'function' ? opts.now : Date.now;
  const rateMax = opts.rateLimitMax ?? RATE_LIMIT_MAX;
  const rateWindow = opts.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;
  // Test-only override so the S1 eviction test doesn't have to insert real
  // MAX_TRACKS-scale data to exercise the cap.
  const maxTracks = opts.maxTracks ?? MAX_TRACKS;

  // Identity-ish fallbacks so tests (and any other future caller) can build a
  // stats instance without wiring index.mjs's sanitisers. main() always
  // injects the real ones — see the index.mjs edit.
  const sanitizeText = opts.sanitizeText || ((raw, max) => String(raw ?? '').slice(0, max));
  const sanitizeArt = opts.sanitizeArt || ((raw) => String(raw ?? '').slice(0, 500));

  mkdirSync(dirname(STORE_PATH), { recursive: true });

  // Cached station-TZ formatter. A bad TZ id must not crash the process —
  // fall back to UTC with a warning (node:24-alpine ships full ICU so this
  // is a config-typo guard, not an expected path).
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
  } catch (e) {
    console.warn('[efm-stats] bad STATS_TZ, falling back to UTC:', e.message);
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
  }

  // { day: 'YYYY-MM-DD', month: 'YYYY-MM', hour: 0..23, dow: 0..6 } in station
  // TZ. dow is derived from the calendar date string via UTC date math — the
  // day-of-week of a given Gregorian date does not depend on timezone, only
  // the date itself, so this avoids any DST edge case in the dow calculation.
  const dateParts = (unixSec) => {
    const parts = fmt.formatToParts(new Date(unixSec * 1000));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    let hour = Number(map.hour);
    if (hour === 24) hour = 0; // ICU midnight quirk
    const day = `${map.year}-${map.month}-${map.day}`;
    const month = `${map.year}-${map.month}`;
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    return { day, month, hour, dow };
  };

  // ---- persisted state ------------------------------------------------------

  const freshState = () => ({
    schema: SCHEMA_VERSION,
    watermark: { playedAt: 0, shId: 0 },
    coveredFrom: null,
    backfill: {
      cursor: null, boundary: null, done: false, halted: false, lastError: null,
      windows: 0, rowsSeen: 0, rowsIngested: 0, resetToken: '',
    },
    totals: { plays: 0, requests: 0, uniqueTracks: 0, peak: { value: 0, at: 0 } },
    days: {},
    hours: Array.from({ length: 24 }, () => ({ p: 0, lsum: 0, lcnt: 0 })),
    dow: Array.from({ length: 7 }, () => ({ p: 0, lsum: 0, lcnt: 0 })),
    // T3: dow x hour rhythm-heatmap accumulator, indexed dow*24+hour (station
    // TZ, same dateParts source as hours/dow above). Populated going forward
    // only — see normalizeLoaded's zero-fill for stores that predate it.
    grid: Array.from({ length: 168 }, () => ({ p: 0, lsum: 0, lcnt: 0 })),
    tracks: {},
    min5: [],
    hourly: [],
  });

  // Defensive merge over a freshly-shaped default — tolerates a hand-edited
  // or partially-written file without throwing.
  const normalizeLoaded = (raw) => {
    const fresh = freshState();
    return {
      schema: SCHEMA_VERSION,
      watermark:
        raw?.watermark && typeof raw.watermark.playedAt === 'number' ? raw.watermark : fresh.watermark,
      coveredFrom: typeof raw?.coveredFrom === 'number' ? raw.coveredFrom : null,
      backfill: { ...fresh.backfill, ...(raw?.backfill || {}) },
      totals: {
        ...fresh.totals,
        ...(raw?.totals || {}),
        peak: { ...fresh.totals.peak, ...(raw?.totals?.peak || {}) },
      },
      days: raw?.days && typeof raw.days === 'object' ? raw.days : {},
      hours: Array.isArray(raw?.hours) && raw.hours.length === 24 ? raw.hours : fresh.hours,
      dow: Array.isArray(raw?.dow) && raw.dow.length === 7 ? raw.dow : fresh.dow,
      // T3: a store from before the grid existed (the entire production
      // history) simply gains an empty one here — the frontend's marginal-
      // strip fallback exists precisely for that gap. A one-time
      // STATS_BACKFILL_RESET re-run repopulates it from history.
      grid: Array.isArray(raw?.grid) && raw.grid.length === 168 ? raw.grid : fresh.grid,
      tracks: raw?.tracks && typeof raw.tracks === 'object' ? raw.tracks : {},
      min5: Array.isArray(raw?.min5) ? raw.min5 : [],
      hourly: Array.isArray(raw?.hourly) ? raw.hourly : [],
    };
  };

  let state = freshState();
  try {
    if (existsSync(STORE_PATH)) {
      const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
      if (raw && raw.schema === SCHEMA_VERSION) {
        state = normalizeLoaded(raw);
      } else {
        console.warn('[efm-stats] unknown schema, starting fresh');
      }
    }
  } catch (e) {
    console.warn('[efm-stats] load failed:', e.message);
    state = freshState();
  }

  let dirty = false;
  let lastSaveAt = clock();

  const save = () => {
    try {
      const tmp = `${STORE_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, STORE_PATH);
      dirty = false;
      lastSaveAt = clock();
    } catch (e) {
      console.warn('[efm-stats] save failed:', e.message);
    }
  };

  const maybeSave = () => {
    if (dirty && clock() - lastSaveAt >= SAVE_INTERVAL_MS) save();
  };

  // ---- reset knob: recoverable via .env + `docker compose up -d`, no volume
  // surgery (the container is read_only). Wipes play-derived data AND the
  // day/hour/dow lsum/lcnt/lmax listener aggregates — recordPlay folds
  // listeners_at_start into those same fields (see foldListener), so a
  // post-reset re-backfill would otherwise fold every history row's
  // listener reading in a SECOND time (S7). The min5/hourly rings and
  // totals.peak survive untouched: they are pure live-sample data that
  // backfill never writes, so they carry no double-fold risk.
  if (RESET_TOKEN && RESET_TOKEN !== state.backfill.resetToken) {
    state.totals.plays = 0;
    state.totals.requests = 0;
    state.totals.uniqueTracks = 0;
    for (const d of Object.values(state.days)) {
      d.p = 0;
      d.r = 0;
      d.lsum = 0;
      d.lcnt = 0;
      d.lmax = 0;
    }
    for (const h of state.hours) {
      h.p = 0;
      h.lsum = 0;
      h.lcnt = 0;
    }
    for (const w of state.dow) {
      w.p = 0;
      w.lsum = 0;
      w.lcnt = 0;
    }
    // T3: grid is play+listener derived, same double-fold risk as
    // hours/dow above — zero it entirely on reset.
    for (const g of state.grid) {
      g.p = 0;
      g.lsum = 0;
      g.lcnt = 0;
    }
    state.tracks = {};
    state.watermark = { playedAt: 0, shId: 0 };
    state.coveredFrom = null;
    state.backfill = {
      cursor: null, boundary: null, done: false, halted: false, lastError: null,
      windows: 0, rowsSeen: 0, rowsIngested: 0, resetToken: RESET_TOKEN,
    };
    save();
  }

  // ---- artistsIdx: derived from tracks, NOT persisted. Rebuilt in one pass
  // at load, then maintained incrementally by recordPlay.
  const artistsIdx = new Map(); // lowercased name -> { name, plays, requests, trackIds, months, first, last }

  const rebuildArtistsIdx = () => {
    artistsIdx.clear();
    for (const [id, t] of Object.entries(state.tracks)) {
      if (!t?.a) continue;
      const key = t.a.toLowerCase();
      let a = artistsIdx.get(key);
      if (!a) {
        a = { name: t.a, plays: 0, requests: 0, trackIds: new Set(), months: {}, first: t.first, last: t.last };
        artistsIdx.set(key, a);
      }
      a.plays += t.n;
      a.requests += t.rq;
      a.trackIds.add(id);
      for (const [m, n] of Object.entries(t.m || {})) a.months[m] = (a.months[m] || 0) + n;
      if (t.first < a.first) a.first = t.first;
      if (t.last >= a.last) {
        a.last = t.last;
        a.name = t.a;
      }
    }
  };
  rebuildArtistsIdx();

  // S5: moves a track's ALREADY-ACCUMULATED aggregate (n, rq, its m map, its
  // trackId) from its current artist's bucket to `newArtist`'s bucket.
  // Called from recordPlay right before a row overwrites t.a, so the
  // incremental path matches rebuildArtistsIdx's semantics — a track's
  // WHOLE n belongs to its single latest artist — instead of splitting
  // counts across two buckets until a restart silently rewrites the
  // leaderboard. A no-op if the artist string didn't actually change.
  const reattributeTrack = (t, id, newArtist) => {
    const oldKey = t.a ? t.a.toLowerCase() : '';
    const newKey = newArtist ? newArtist.toLowerCase() : '';
    if (oldKey === newKey) return;
    const oldBucket = oldKey ? artistsIdx.get(oldKey) : null;
    if (oldBucket) {
      oldBucket.plays -= t.n;
      oldBucket.requests -= t.rq;
      oldBucket.trackIds.delete(id);
      for (const [m, n] of Object.entries(t.m)) {
        const left = (oldBucket.months[m] || 0) - n;
        if (left > 0) oldBucket.months[m] = left;
        else delete oldBucket.months[m];
      }
      // Bucket fully drained — drop it rather than leave a zero-play ghost
      // artist sitting in the leaderboard.
      if (oldBucket.trackIds.size === 0) artistsIdx.delete(oldKey);
    }
    if (!newKey) return; // new artist is blank — rebuild would skip it too
    let newBucket = artistsIdx.get(newKey);
    if (!newBucket) {
      newBucket = { name: newArtist, plays: 0, requests: 0, trackIds: new Set(), months: {}, first: t.first, last: t.last };
      artistsIdx.set(newKey, newBucket);
    }
    newBucket.plays += t.n;
    newBucket.requests += t.rq;
    newBucket.trackIds.add(id);
    for (const [m, n] of Object.entries(t.m)) {
      newBucket.months[m] = (newBucket.months[m] || 0) + n;
    }
    if (t.first < newBucket.first) newBucket.first = t.first;
    if (t.last > newBucket.last) newBucket.last = t.last;
  };

  // ---- ingestion core --------------------------------------------------------

  const ensureDay = (day) => {
    let d = state.days[day];
    if (!d) {
      d = { p: 0, r: 0, lsum: 0, lcnt: 0, lmax: 0 };
      state.days[day] = d;
    }
    return d;
  };

  // Shared by both listener data sources: the live 30s sample AND a play
  // row's own listeners_at_start field (backfill/syncRecent rows carry one).
  const foldListener = (unixSec, v) => {
    const { day, hour, dow } = dateParts(unixSec);
    const d = ensureDay(day);
    d.lsum += v;
    d.lcnt += 1;
    if (v > d.lmax) d.lmax = v;
    const h = state.hours[hour];
    h.lsum += v;
    h.lcnt += 1;
    const w = state.dow[dow];
    w.lsum += v;
    w.lcnt += 1;
    // T3: same reading, folded into the rhythm-heatmap cell — shared by
    // both callers of foldListener (the live 30s sample and a play row's
    // own listeners_at_start), same as hours/dow above.
    const g = state.grid[dow * 24 + hour];
    g.lsum += v;
    g.lcnt += 1;
    if (v > state.totals.peak.value) state.totals.peak = { value: v, at: unixSec };
    dirty = true;
  };

  const bucketPush = (ring, cap, stepSec, t, v) => {
    const bucketT = Math.floor(t / stepSec) * stepSec;
    const last = ring[ring.length - 1];
    let bucket = last && last.t === bucketT ? last : null;
    if (!bucket) {
      bucket = { t: bucketT, sum: 0, cnt: 0, max: 0 };
      ring.push(bucket);
      while (ring.length > cap) ring.shift();
    }
    bucket.sum += v;
    bucket.cnt += 1;
    if (v > bucket.max) bucket.max = v;
  };

  // Internal — callers gate with isValidRow()/passesWatermark() first as
  // appropriate for their stream. Returns true iff the row was counted.
  const recordPlay = (row) => {
    const playedAt = Number(row?.played_at);
    const songId = row?.song?.id;
    if (!Number.isFinite(playedAt) || playedAt <= 0 || typeof songId !== 'string' || !songId) return false;

    const isRequest = row.is_request === true || row.is_requested === true;
    const title = sanitizeText(row.song?.title || row.song?.text || '', 200);
    const artist = sanitizeText(row.song?.artist || '', 200);
    const art = sanitizeArt(row.song?.art);
    const { day, month, hour, dow } = dateParts(playedAt);

    state.totals.plays += 1;
    if (isRequest) state.totals.requests += 1;
    const d = ensureDay(day);
    d.p += 1;
    if (isRequest) d.r += 1;
    state.hours[hour].p += 1;
    state.dow[dow].p += 1;
    state.grid[dow * 24 + hour].p += 1; // T3

    let t = state.tracks[songId];
    const isNewTrack = !t;
    if (!t) {
      t = { t: title, a: artist, art, n: 0, rq: 0, first: playedAt, last: playedAt, m: {} };
      state.tracks[songId] = t;
      state.totals.uniqueTracks += 1; // monotonic — survives cap eviction below
    }

    // S5: this row is about to become the track's "latest" metadata (see
    // the playedAt >= t.last block below) — if its artist differs from the
    // track's current one, move the track's aggregate to the new artist's
    // bucket BEFORE this row's own increments are applied, using t.n/t.rq/
    // t.m as they stood just before this play.
    if (!isNewTrack && playedAt >= t.last && artist !== t.a) {
      reattributeTrack(t, songId, artist);
    }

    t.n += 1;
    if (isRequest) t.rq += 1;
    if (playedAt < t.first) t.first = playedAt;
    if (playedAt >= t.last) {
      t.last = playedAt;
      t.t = title;
      t.a = artist;
      t.art = art;
    }
    t.m[month] = (t.m[month] || 0) + 1;

    if (artist) {
      const key = artist.toLowerCase();
      let a = artistsIdx.get(key);
      if (!a) {
        a = { name: artist, plays: 0, requests: 0, trackIds: new Set(), months: {}, first: playedAt, last: playedAt };
        artistsIdx.set(key, a);
      }
      a.plays += 1;
      if (isRequest) a.requests += 1;
      a.trackIds.add(songId);
      a.months[month] = (a.months[month] || 0) + 1;
      if (playedAt < a.first) a.first = playedAt;
      if (playedAt >= a.last) {
        a.last = playedAt;
        a.name = artist;
      }
    }

    // S1: far-tail safety valve, amortized. The eviction scan used to run
    // BEFORE t.n += 1 with the just-inserted track still at n:0, so it was
    // always its own argmin and `evictId !== songId` skipped the delete —
    // a permanent no-op that still paid a full-map scan on every insert
    // past the cap. Now it runs after this row's increments (so songId is
    // never a spurious argmin), is explicitly excluded from the scan
    // anyway, and batch-evicts down to maxTracks - 100 in one sorted pass
    // so it only fires once per ~100 inserts past the cap, not per insert.
    if (isNewTrack && Object.keys(state.tracks).length > maxTracks) {
      const targetSize = Math.max(0, maxTracks - 100);
      const entries = Object.entries(state.tracks).filter(([id]) => id !== songId);
      entries.sort((a, b) => a[1].n - b[1].n);
      const evictCount = entries.length - targetSize;
      for (let i = 0; i < evictCount && i < entries.length; i++) {
        delete state.tracks[entries[i][0]];
      }
    }

    if (state.coveredFrom == null || playedAt < state.coveredFrom) state.coveredFrom = playedAt;

    const lv = row.listeners_at_start ?? row.listeners_start ?? null;
    if (typeof lv === 'number' && Number.isFinite(lv) && lv >= 0) foldListener(playedAt, lv);

    dirty = true;
    return true;
  };

  // FORWARD gate — shared by live ingest + syncRecent. A row counts iff it is
  // strictly newer than the watermark (played_at, sh_id) lexicographically.
  const passesWatermark = (row) => {
    const playedAt = Number(row.played_at);
    const shId = Number(row.sh_id ?? 0);
    return playedAt > state.watermark.playedAt || (playedAt === state.watermark.playedAt && shId > state.watermark.shId);
  };
  const advanceWatermark = (row) => {
    state.watermark = { playedAt: Number(row.played_at), shId: Number(row.sh_id ?? 0) };
  };

  // In-memory only — boot-gap ordering (see module header). Reset never
  // needed: a process restart naturally re-holds live ingest until sync
  // succeeds (or fails 3x) again, which is exactly the safe behaviour.
  let syncOkAt = 0;
  let syncFailures = 0;
  let lastSyncAttempt = 0;

  const ingestNowPlaying = (data) => {
    if (!data || typeof data !== 'object') return;
    const nowSec = Math.floor(clock() / 1000);

    if (data.is_online !== false) {
      const v = Number(data.listeners?.current ?? 0);
      if (Number.isFinite(v) && v >= 0) {
        bucketPush(state.min5, MIN5_CAP, 300, nowSec, v);
        bucketPush(state.hourly, HOURLY_CAP, 3600, nowSec, v);
        foldListener(nowSec, v);
      }
    }

    // On boot after downtime, syncRecent must fill the gap below "now"
    // BEFORE live ingest advances the watermark past it — but a broken key
    // must not disable stats forever, hence the 3-failure escape hatch.
    const holdLive = !!API_KEY && !syncOkAt && syncFailures < 3;
    if (!holdLive) {
      const candidates = [data.now_playing, ...(Array.isArray(data.song_history) ? data.song_history : [])].filter(
        isValidRow,
      );
      for (const row of sortRows(candidates)) {
        if (!passesWatermark(row)) continue;
        if (recordPlay(row)) advanceWatermark(row);
      }
    }

    maybeSave();
  };

  // ---- syncRecent (apiKey present) -------------------------------------------

  const syncRecent = async (fetchImpl) => {
    try {
      const baseSec = state.watermark.playedAt || Math.floor(clock() / 1000) - 6 * 3600;
      const startDate = addDaysToISODate(dateParts(baseSec).day, -1);
      const endDate = addDaysToISODate(dateParts(Math.floor(clock() / 1000)).day, 1);
      const url = `${API_BASE}/station/${STATION_ID}/history?start=${startDate}&end=${endDate}`;
      // S2: route through fetchHistoryPaginated (defined below) so the
      // WHOLE window is drained before the watermark is allowed to advance
      // — reading only the first page used to strand any gap rows past it
      // below the watermark forever once an outage outlasted
      // song_history's ~45min reach.
      const result = await fetchHistoryPaginated(fetchImpl, url);
      if (result.error) {
        // S6: sync failures never touch state.backfill.lastError — that
        // field is owned exclusively by backfillStep, so a successful sync
        // running 10 min later can't erase why a halted backfill halted.
        // Sync's own health is the syncFailures counter + lastOkAt, both
        // surfaced at /stats/health under `sync`.
        syncFailures += 1;
        console.warn('[efm-stats] syncRecent failed:', result.error);
        return;
      }
      for (const row of sortRows(result.list.filter(isValidRow))) {
        if (!passesWatermark(row)) continue;
        if (recordPlay(row)) advanceWatermark(row);
      }
      syncOkAt = clock();
      syncFailures = 0;
    } catch (e) {
      syncFailures += 1;
      console.warn('[efm-stats] syncRecent error:', e.message);
    }
  };

  // ---- tick -------------------------------------------------------------------

  const tick = async (fetchImpl = fetch) => {
    try {
      if (API_KEY && clock() - lastSyncAttempt >= SYNC_INTERVAL_MS) {
        lastSyncAttempt = clock();
        await syncRecent(fetchImpl); // must finish before live ingest — see boot-gap ordering
      }
      const r = await fetchImpl(`${API_BASE}/nowplaying/${STATION_ID}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) {
        console.warn('[efm-stats] nowplaying fetch failed:', r.status);
        return;
      }
      const data = await r.json();
      ingestNowPlaying(data);
    } catch (e) {
      console.warn('[efm-stats] tick failed:', e.message);
    }
  };

  // ---- backfill -----------------------------------------------------------------

  // Follows AzuraCast's `links.next` pagination, up to BACKFILL_MAX_PAGES.
  // Returns { list } on success or { error } — never throws.
  const fetchHistoryPaginated = async (fetchImpl, url) => {
    const apiOrigin = new URL(API_BASE).origin;
    const rows = [];
    let next = url;
    let pages = 0;
    while (next) {
      pages += 1;
      if (pages > BACKFILL_MAX_PAGES) return { error: 'too many pages' };
      let r;
      try {
        r = await fetchImpl(next, { headers: { 'X-API-Key': API_KEY }, signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        return { error: e.name === 'TimeoutError' ? 'timeout' : 'fetch failed' };
      }
      if (!r.ok) return { error: `http ${r.status}` };
      let body;
      try {
        body = await r.json();
      } catch {
        return { error: 'fetch failed' };
      }
      if (Array.isArray(body)) {
        rows.push(...body);
        next = null;
        continue;
      }
      const pageRows = Array.isArray(body?.rows) ? body.rows : [];
      rows.push(...pageRows);
      const more =
        !!body?.links?.next || body?.has_next_page === true || (typeof body?.total === 'number' && body.total > rows.length);
      const rawNext = more ? (body?.links?.next ?? null) : null;
      if (rawNext) {
        // S4 (SSRF): links.next is upstream-supplied and would otherwise be
        // fetched verbatim WITH the API key attached — a compromised or
        // redirect-abused history endpoint could point it at an internal
        // host (docker bridge siblings, the metadata endpoint, etc.) and
        // exfiltrate the key. Resolve relative to API_BASE and require the
        // result stay on API_BASE's origin before it is ever fetched; the
        // first-page URL is always self-built, so this only ever gates
        // subsequent pages.
        let resolved;
        try {
          resolved = new URL(rawNext, API_BASE);
        } catch {
          return { error: 'bad next url' };
        }
        if (resolved.origin !== apiOrigin) return { error: 'bad next url' };
        next = resolved.href;
      } else {
        next = null;
      }
    }
    return { list: rows };
  };

  // S3: in-memory only (deliberately not persisted, like `busy` below) —
  // exponential backoff for TRANSIENT backfill errors (5xx, timeout, fetch
  // failed). Reset to 0 on any successful window.
  let consecutiveErrors = 0;
  let backoffUntil = 0;

  // Permanent backfill errors get `halted = true` (recovery is the reset
  // knob, same as 'shape mismatch') instead of being retried forever:
  // 'too many pages' re-fires BACKFILL_MAX_PAGES authenticated requests
  // every retry with no possible different outcome, a 4xx means the
  // request itself is invalid (bad key, revoked, etc — retrying changes
  // nothing), and 'bad next url' (S4) means the upstream response is
  // actively hostile. Everything else (5xx, timeout, fetch failed) is
  // treated as transient and backed off instead.
  const isPermanentBackfillError = (err) => {
    if (err === 'too many pages' || err === 'bad next url') return true;
    const m = /^http (\d\d\d)$/.exec(err);
    return !!m && Number(m[1]) >= 400 && Number(m[1]) < 500;
  };

  let busy = false;

  const backfillStep = async (fetchImpl = fetch) => {
    if (state.backfill.done || state.backfill.halted) return false;
    if (busy) return true; // re-entrancy guard — a step is already in flight
    busy = true;
    try {
      // boundary is frozen ONCE, on the first step after the forward region
      // has actually started. It must be the forward region's FLOOR —
      // coveredFrom, the oldest row the forward streams ingested — NOT the
      // watermark head: syncRecent's first run pulls a day or two of history
      // below the head, and a head-based boundary would let backfill
      // re-ingest exactly those rows (double count). Until backfill ingests
      // anything, coveredFrom is purely forward, so freezing it here is
      // exact. Never recomputed afterwards — coveredFrom moves down as
      // backfill ingests old rows, but boundary must stay fixed or backfill
      // could chase forever.
      if (!state.backfill.boundary) {
        if (state.coveredFrom != null && state.watermark.playedAt > 0) {
          state.backfill.boundary = { playedAt: state.coveredFrom, day: dateParts(state.coveredFrom).day };
          save();
        }
        return true; // no-op until frozen
      }
      if (!API_KEY) return true;

      // S3: still backing off from a recent transient error — no-op (and
      // crucially, no fetch) until backoffUntil passes. Returning true
      // keeps index.mjs's setTimeout chain alive at its normal 15s cadence
      // so we naturally retry once the window elapses.
      if (clock() < backoffUntil) return true;

      if (state.backfill.cursor == null) state.backfill.cursor = BACKFILL_START;
      const boundary = state.backfill.boundary;
      const cursor = state.backfill.cursor;

      if (cursor > boundary.day) {
        state.backfill.done = true;
        save();
        return false;
      }

      const windowEndDay = addDaysToISODate(cursor, BACKFILL_WINDOW_DAYS);
      const clampedEndDay = windowEndDay < boundary.day ? windowEndDay : boundary.day;
      // Request one day wider than the window — the API's inclusive/exclusive
      // boundary semantics are untrusted; the numeric filter below is the
      // real source of truth.
      const reqEnd = addDaysToISODate(clampedEndDay, 1);
      const url = `${API_BASE}/station/${STATION_ID}/history?start=${cursor}&end=${reqEnd}`;

      const result = await fetchHistoryPaginated(fetchImpl, url);
      if (result.error) {
        state.backfill.lastError = result.error;
        if (isPermanentBackfillError(result.error)) {
          state.backfill.halted = true;
          save();
          return false; // deterministic — retrying can never change the outcome
        }
        // Transient (5xx/timeout/fetch failed) — exponential backoff,
        // capped at 15min, instead of the previous unconditional 15s
        // retry. consecutiveErrors resets on any successful window below.
        consecutiveErrors += 1;
        backoffUntil = clock() + Math.min(15 * 60_000, 15_000 * 2 ** consecutiveErrors);
        save();
        return true; // retry same window once backoffUntil passes
      }
      consecutiveErrors = 0;

      const rows = result.list;
      state.backfill.rowsSeen += rows.length;

      let ingestedThisWindow = 0;
      let anyValid = false;
      for (const row of rows) {
        if (!isValidRow(row)) continue;
        anyValid = true;
        const dp = dateParts(Number(row.played_at));
        // Numeric row filter — the idempotence guarantee. A row outside the
        // requested window (over-returning API) or already in the forward
        // region (>= boundary.playedAt) is skipped, never double-counted.
        if (dp.day < cursor || dp.day > clampedEndDay) continue;
        if (Number(row.played_at) >= boundary.playedAt) continue;
        if (recordPlay(row)) {
          ingestedThisWindow += 1;
          state.backfill.rowsIngested += 1;
        }
      }

      // Shape-mismatch tripwire: rows came back but NONE were even
      // basically valid (numeric played_at + song id) — the response shape
      // changed underneath us. A window whose rows are simply all outside
      // the numeric filter (the boundary window) is fine and must NOT halt.
      if (rows.length > 0 && ingestedThisWindow === 0 && !anyValid) {
        state.backfill.halted = true;
        state.backfill.lastError = 'shape mismatch';
        save();
        return false;
      }

      state.backfill.cursor = addDaysToISODate(clampedEndDay, 1);
      state.backfill.windows += 1;
      state.backfill.lastError = null;
      save();
      return true;
    } finally {
      busy = false;
    }
  };

  // ---- serialization (endpoints) -----------------------------------------------

  const densifyDays = (fromDay, toDay) => {
    const out = [];
    let d = fromDay;
    let guard = 0;
    while (d <= toDay && guard < 100_000) {
      const entry = state.days[d];
      out.push({
        d,
        p: entry?.p || 0,
        r: entry?.r || 0,
        lavg: entry && entry.lcnt ? round1(entry.lsum / entry.lcnt) : null,
        lmax: entry && entry.lcnt ? entry.lmax : null,
      });
      d = addDaysToISODate(d, 1);
      guard += 1;
    }
    return out.length > MAX_DAY_POINTS ? out.slice(out.length - MAX_DAY_POINTS) : out;
  };

  const trackPayload = (id, t) => ({
    id,
    title: t.t,
    artist: t.a,
    art: t.art,
    plays: t.n,
    requests: t.rq,
    firstAt: t.first,
    lastAt: t.last,
    months: Object.entries(t.m || {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([m, p]) => ({ m, p })),
  });

  const artistPayload = (a) => ({
    name: a.name,
    plays: a.plays,
    requests: a.requests,
    tracks: a.trackIds.size,
    firstAt: a.first,
    lastAt: a.last,
    months: Object.entries(a.months || {})
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([m, p]) => ({ m, p })),
    topTracks: [...a.trackIds]
      .map((id) => ({ id, t: state.tracks[id] }))
      .filter((x) => x.t)
      .sort((x, y) => y.t.n - x.t.n)
      .slice(0, 20)
      .map((x) => ({ id: x.id, title: x.t.t, art: x.t.art, plays: x.t.n })),
  });

  // T2: single source of truth for the coverage/backfill state string, used
  // by both /stats/summary's meta.coverage.backfill and /stats/health's
  // backfill.state. Previously meta.coverage.backfill went straight to
  // 'none' whenever API_KEY was absent, even with a fully-done backfill
  // (production's actual shape: done=true, key since removed) — halted/done
  // must be reported regardless of whether a key is currently configured,
  // since they describe what already happened, not what a key would do now.
  const backfillState = () =>
    state.backfill.halted ? 'halted' : state.backfill.done ? 'done' : API_KEY ? 'running' : 'none';

  // T1: per-range rollups for /stats/summary. Per-track/per-artist data is
  // only month-granular, so each window is deliberately month-floored (the
  // client labels it "since <Mon YYYY>") rather than day-exact like the KPI
  // tiles, which read the dense `days` series client-side instead.
  //
  // Single pass over tracks (and one over artistsIdx): each entry's months
  // map is walked once, and each month's count is folded into every window
  // bucket whose sinceMonth is <= that month — O(tracks x months) with a
  // constant (4) window fan-out per month, not O(tracks x months x windows)
  // in any bigger-O sense.
  const RANGE_DAY_WINDOWS = [
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
    ['1y', 365],
  ];
  const computeRanges = (nowSec) => {
    const sinceMonths = RANGE_DAY_WINDOWS.map(([key, days]) => [key, dateParts(nowSec - days * 86_400).month]);

    const trackAgg = new Map(RANGE_DAY_WINDOWS.map(([key]) => [key, new Map()])); // key -> Map<trackId, plays>
    for (const [id, t] of Object.entries(state.tracks)) {
      for (const [m, n] of Object.entries(t.m || {})) {
        for (const [key, sinceMonth] of sinceMonths) {
          if (m >= sinceMonth) {
            const bucket = trackAgg.get(key);
            bucket.set(id, (bucket.get(id) || 0) + n);
          }
        }
      }
    }

    const artistAgg = new Map(RANGE_DAY_WINDOWS.map(([key]) => [key, new Map()])); // key -> Map<artistKey, plays>
    for (const [artistKey, a] of artistsIdx) {
      for (const [m, n] of Object.entries(a.months || {})) {
        for (const [key, sinceMonth] of sinceMonths) {
          if (m >= sinceMonth) {
            const bucket = artistAgg.get(key);
            bucket.set(artistKey, (bucket.get(artistKey) || 0) + n);
          }
        }
      }
    }

    const ranges = {};
    for (const [key, sinceMonth] of sinceMonths) {
      const trackBucket = trackAgg.get(key);
      // requests here is the track's ALL-TIME rq, not range-scoped — per-play
      // request flags aren't month-granular so a true range sum isn't cheap
      // to derive from `m`. Still useful for the top-list rows; the KPI
      // requests tile uses an exact day-sum instead (client-side, from the
      // dense `days` series).
      const topTracks = [...trackBucket.entries()]
        .map(([id, plays]) => {
          const t = state.tracks[id];
          return { id, title: t.t, artist: t.a, art: t.art, plays, requests: t.rq };
        })
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 25);

      const artistBucket = artistAgg.get(key);
      const topArtists = [...artistBucket.entries()]
        .map(([artistKey, plays]) => {
          const a = artistsIdx.get(artistKey);
          // Same all-time-requests note as topTracks above. `tracks` is a
          // true range count though: how many of this artist's trackIds
          // actually had a month in this window (not the artist's all-time
          // track count).
          const tracks = [...a.trackIds].filter((id) => trackBucket.has(id)).length;
          return { name: a.name, plays, requests: a.requests, tracks };
        })
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 25);

      ranges[key] = {
        sinceMonth,
        uniqueTracks: trackBucket.size,
        uniqueArtists: artistBucket.size,
        topTracks,
        topArtists,
      };
    }
    return ranges;
  };

  let summaryCache = null;
  let summaryCacheAt = 0;
  const computeSummary = () => {
    const nowSec = Math.floor(clock() / 1000);
    const fromDay = state.coveredFrom != null ? dateParts(state.coveredFrom).day : dateParts(nowSec).day;
    const toDay = dateParts(nowSec).day;

    const topTracks = Object.entries(state.tracks)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 50)
      .map(([id, t]) => trackPayload(id, t));

    const topArtists = [...artistsIdx.values()]
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 50)
      .map((a) => ({ name: a.name, plays: a.plays, requests: a.requests, tracks: a.trackIds.size }));

    return {
      ok: true,
      meta: {
        generatedAt: nowSec,
        timezone: TZ,
        coverage: {
          from: state.coveredFrom,
          to: state.watermark.playedAt || null,
          backfill: backfillState(),
        },
      },
      totals: {
        plays: state.totals.plays,
        requests: state.totals.requests,
        uniqueTracks: state.totals.uniqueTracks,
        uniqueArtists: artistsIdx.size,
        peakListeners: { value: state.totals.peak.value, at: state.totals.peak.at },
        firstPlayAt: state.coveredFrom,
        lastPlayAt: state.watermark.playedAt || null,
      },
      days: densifyDays(fromDay, toDay),
      hours: state.hours.map((h, i) => ({ h: i, p: h.p, lavg: h.lcnt ? round1(h.lsum / h.lcnt) : null })),
      dow: state.dow.map((w, i) => ({ w: i, p: w.p, lavg: w.lcnt ? round1(w.lsum / w.lcnt) : null })),
      // T3: always emitted (~6KB) — all-zero on a store that predates the
      // grid, which is exactly why the frontend has a marginal-strip
      // fallback for that case rather than a "no data yet" server flag.
      grid: state.grid.map((g, i) => ({ w: Math.floor(i / 24), h: i % 24, p: g.p, lavg: g.lcnt ? round1(g.lsum / g.lcnt) : null })),
      topTracks,
      topArtists,
      ranges: computeRanges(nowSec),
    };
  };
  const buildSummary = () => {
    if (summaryCache && clock() - summaryCacheAt < CACHE_TTL_MS) return summaryCache;
    summaryCache = computeSummary();
    summaryCacheAt = clock();
    return summaryCache;
  };

  const bucketToPoint = (b) => ({ t: b.t, avg: b.cnt ? round1(b.sum / b.cnt) : null, max: b.cnt ? b.max : null });

  // Ring buckets are appended in arrival order, which normally IS time order —
  // but a clock step (NTP, restart with a skewed host clock) can leave the
  // ring locally unsorted or with a duplicate bucket for the same t. Clients
  // densify these series by walking first→last t, so serve them SORTED with
  // duplicate-t buckets merged (weighted, max-of-max) rather than trusting
  // arrival order.
  const sortedMerged = (buckets) => {
    const sorted = buckets.slice().sort((a, b) => a.t - b.t);
    const out = [];
    for (const b of sorted) {
      const last = out[out.length - 1];
      if (last && last.t === b.t) {
        last.sum += b.sum;
        last.cnt += b.cnt;
        if (b.max > last.max) last.max = b.max;
      } else {
        out.push({ ...b });
      }
    }
    return out;
  };

  const computeListeners = (range) => {
    const nowSec = Math.floor(clock() / 1000);
    if (range === '7d' || range === '30d') {
      const days = range === '7d' ? 7 : 30;
      const cutoff = nowSec - days * 86_400;
      return { ok: true, range, step: 3600, points: sortedMerged(state.hourly.filter((b) => b.t >= cutoff)).map(bucketToPoint) };
    }
    if (range === 'all') {
      const fromDay = state.coveredFrom != null ? dateParts(state.coveredFrom).day : dateParts(nowSec).day;
      const toDay = dateParts(nowSec).day;
      const points = [];
      let d = fromDay;
      let guard = 0;
      while (d <= toDay && guard < 100_000) {
        const entry = state.days[d];
        points.push({
          d,
          avg: entry && entry.lcnt ? round1(entry.lsum / entry.lcnt) : null,
          max: entry && entry.lcnt ? entry.lmax : null,
        });
        d = addDaysToISODate(d, 1);
        guard += 1;
      }
      return { ok: true, range: 'all', step: 86_400, points: points.length > MAX_DAY_POINTS ? points.slice(points.length - MAX_DAY_POINTS) : points };
    }
    // default: 24h
    const cutoff = nowSec - 24 * 3600;
    return { ok: true, range: '24h', step: 300, points: sortedMerged(state.min5.filter((b) => b.t >= cutoff)).map(bucketToPoint) };
  };
  const listenersCache = new Map(); // range -> { at, payload }
  const buildListeners = (range) => {
    const key = ['24h', '7d', '30d', 'all'].includes(range) ? range : '24h';
    const cached = listenersCache.get(key);
    if (cached && clock() - cached.at < CACHE_TTL_MS) return cached.payload;
    const payload = computeListeners(key);
    listenersCache.set(key, { at: clock(), payload });
    return payload;
  };

  // ---- HTTP -----------------------------------------------------------------

  // Client IP for the rate limiter. Duplicated from index.mjs (not imported —
  // index.mjs imports THIS module, so importing back would be circular).
  // Same reasoning as there: trust X-Forwarded-For only because this service
  // is reachable solely via our own Caddy, which sets it from the real
  // {remote_host}; take the RIGHTMOST entry so a client-supplied XFF prefix
  // can't spoof the limiter.
  const clientIp = (req) => {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const parts = xff.split(',');
      return parts[parts.length - 1].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
  };

  const buckets = new Map(); // ip -> { count, resetAt }
  const rateLimited = (ip) => {
    const now = clock();
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

  const respond = (res, code, body, cacheControl) => {
    res.writeHead(code, {
      'content-type': 'application/json',
      'cache-control': cacheControl || 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  const KNOWN_ROUTES = new Set(['/stats/health', '/stats/summary', '/stats/listeners', '/stats/track', '/stats/artist']);

  // Returns TRUE iff it wrote a response (so index.mjs's server can fall
  // through to store.handler's own 404 for anything not a known GET /stats
  // route — see the fallthrough contract in the index.mjs wiring).
  const handler = async (req, res) => {
    try {
      if (req.method !== 'GET' || !(req.url || '').startsWith('/stats/')) return false;

      // Values from URLSearchParams are ALREADY percent-decoded — never
      // decodeURIComponent them again (that would double-decode a value
      // like "a%2520b" into something the client never sent).
      const parsed = new URL(req.url, 'http://x');
      if (!KNOWN_ROUTES.has(parsed.pathname)) return false;

      if (rateLimited(clientIp(req))) {
        respond(res, 429, { error: 'rate limited' });
        return true;
      }

      if (parsed.pathname === '/stats/health') {
        respond(res, 200, {
          ok: true,
          plays: state.totals.plays,
          coveredFrom: state.coveredFrom,
          // lastError is status-code-level only ('http 403', 'timeout',
          // 'too many pages', 'shape mismatch', 'bad next url' — see
          // fetchHistoryPaginated/backfillStep) and NEVER free text, so
          // it's safe to expose and makes a halted/backed-off backfill
          // observable (S3).
          // T2: `state` mirrors meta.coverage.backfill's derivation (see
          // backfillState) so a done-but-keyless deploy (production, since
          // the key was removed post-backfill) reports 'done' here too,
          // not just via the enabled/done/halted booleans that were already
          // present.
          backfill: {
            enabled: !!API_KEY,
            done: state.backfill.done,
            halted: state.backfill.halted,
            lastError: state.backfill.lastError,
            state: backfillState(),
          },
          // S6: sync's own health, kept separate from backfill.lastError
          // (which sync never writes to).
          sync: { failures: syncFailures, lastOkAt: syncOkAt || null },
        });
        return true;
      }

      if (parsed.pathname === '/stats/summary') {
        respond(res, 200, buildSummary(), 'public, max-age=60');
        return true;
      }

      if (parsed.pathname === '/stats/listeners') {
        respond(res, 200, buildListeners(parsed.searchParams.get('range') || '24h'), 'public, max-age=60');
        return true;
      }

      if (parsed.pathname === '/stats/track') {
        const id = parsed.searchParams.get('id') || '';
        if (!/^[0-9a-f]{16,64}$/i.test(id)) {
          respond(res, 400, { error: 'invalid id' });
          return true;
        }
        const t = state.tracks[id];
        if (!t) {
          respond(res, 404, { error: 'not found' });
          return true;
        }
        respond(res, 200, { ok: true, track: trackPayload(id, t) }, 'public, max-age=300');
        return true;
      }

      if (parsed.pathname === '/stats/artist') {
        const name = (parsed.searchParams.get('name') || '').trim().slice(0, 200).toLowerCase();
        const a = name ? artistsIdx.get(name) : null;
        if (!a) {
          respond(res, 404, { error: 'not found' });
          return true;
        }
        respond(res, 200, { ok: true, artist: artistPayload(a) }, 'public, max-age=300');
        return true;
      }

      return false;
    } catch (e) {
      console.warn('[efm-stats] handler error:', e.message);
      respond(res, 500, { error: 'server error' });
      return true;
    }
  };

  return { handler, ingestNowPlaying, tick, backfillStep, save, state };
}
