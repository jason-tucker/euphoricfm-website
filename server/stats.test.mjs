// Tests for the efm-stats full-time station stats module.
//
// Run: `node --test server/` (built-in node:test, zero deps). Injected `now`
// + fetchImpl fakes make everything deterministic; temp dirs via
// mkdtempSync. sanitizeText/sanitizeArt are the real ones imported from
// index.mjs — importing it has no side effects (no listen, no timers), see
// the invokedDirectly guard there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStats } from './stats.mjs';
import { sanitizeText, sanitizeArt } from './index.mjs';

const TZ = 'America/New_York';

// ---- Helpers ---------------------------------------------------------------

// Composes stats.handler + a stub store.handler EXACTLY as main() does, so
// the fallthrough contract (stats.handler returns false -> store 404s) is
// exercised the same way the real server exercises it.
function withServer(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'efm-stats-'));
  const storePath = join(dir, 'stats.json');
  const clockRef = { t: opts.startMs ?? Date.parse('2026-01-15T12:00:00Z') };
  const now = opts.now || (() => clockRef.t);
  const stats = createStats({
    storePath,
    timezone: TZ,
    sanitizeText,
    sanitizeArt,
    now,
    ...opts,
  });
  const storeHandler = async (req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  };
  const server = createServer(async (req, res) => {
    const handled = await stats.handler(req, res);
    if (!handled) return storeHandler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        stats,
        dir,
        clockRef,
        base: `http://127.0.0.1:${port}`,
        storePath,
        close: () =>
          new Promise((r) => server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); })),
      });
    });
  });
}

// A minimal song_history/now_playing row.
function row(id, playedAt, opts = {}) {
  return {
    sh_id: opts.shId ?? playedAt,
    played_at: playedAt,
    is_request: opts.isRequest ?? false,
    listeners_at_start: opts.listeners ?? null,
    song: { id, title: opts.title ?? `Title ${id}`, artist: opts.artist ?? `Artist ${id}`, art: opts.art ?? '' },
  };
}

function nowPlayingPayload({ nowPlaying, history = [], listeners = 5, isOnline = true } = {}) {
  return {
    is_online: isOnline,
    listeners: { current: listeners },
    now_playing: nowPlaying,
    song_history: history,
  };
}

const fakeFetchJson = (body, ok = true, status = 200) => async () => ({
  ok,
  status,
  json: async () => body,
});

// A day known to fall on the same calendar date in both UTC and ET (well
// clear of the 03:00 UTC / previous-ET-day boundary tested separately).
const T_NOON = Date.parse('2026-01-15T18:00:00Z') / 1000; // 13:00 ET

// Seeds the state a real forward ingest would leave behind: watermark at the
// region's HEAD and coveredFrom at its FLOOR. The backfill boundary freezes
// from the FLOOR (coveredFrom) — freezing from the head was an actual
// double-count bug (syncRecent's first run pulls rows below the head, and a
// head-based boundary let backfill re-ingest them), so tests seed both.
const seedForward = (s, floorTs, headTs = floorTs) => {
  s.stats.state.watermark = { playedAt: headTs, shId: 1 };
  s.stats.state.coveredFrom = floorTs;
};

// ---- 1. Live ingest (no key) ------------------------------------------------

test('live ingest aggregates plays/requests/days/hours/dow/tracks/months; same history twice counts once', async () => {
  const s = await withServer();
  try {
    const r1 = row('song-a', T_NOON, { isRequest: true, listeners: 10 });
    const payload = nowPlayingPayload({ nowPlaying: r1, history: [] });
    s.stats.ingestNowPlaying(payload);
    s.stats.ingestNowPlaying(payload); // same now_playing row again — watermark must dedupe

    assert.equal(s.stats.state.totals.plays, 1);
    assert.equal(s.stats.state.totals.requests, 1);
    assert.equal(s.stats.state.totals.uniqueTracks, 1);
    const t = s.stats.state.tracks['song-a'];
    assert.equal(t.n, 1);
    assert.equal(t.rq, 1);
  } finally {
    await s.close();
  }
});

test('out-of-order rows within a single poll are sorted before gating', async () => {
  const s = await withServer();
  try {
    // song_history delivered newest-first; now_playing is the actual latest.
    const older = row('a', T_NOON, { shId: 1 });
    const newer = row('b', T_NOON + 60, { shId: 2 });
    const payload = nowPlayingPayload({ nowPlaying: newer, history: [older] });
    s.stats.ingestNowPlaying(payload);
    assert.equal(s.stats.state.totals.plays, 2);
    assert.equal(s.stats.state.watermark.playedAt, T_NOON + 60);
    assert.equal(s.stats.state.watermark.shId, 2);
  } finally {
    await s.close();
  }
});

// ---- 2. Listener sampling ----------------------------------------------------

test('listener sampling buckets min5/hourly avg+max, enforces caps, tracks peak; is_online:false contributes nothing', async () => {
  const s = await withServer();
  try {
    s.stats.ingestNowPlaying(nowPlayingPayload({ listeners: 4 }));
    s.clockRef.t += 60_000;
    s.stats.ingestNowPlaying(nowPlayingPayload({ listeners: 8 }));
    assert.equal(s.stats.state.min5.length, 1); // same 5-min bucket
    assert.equal(s.stats.state.min5[0].sum, 12);
    assert.equal(s.stats.state.min5[0].cnt, 2);
    assert.equal(s.stats.state.min5[0].max, 8);
    assert.equal(s.stats.state.totals.peak.value, 8);

    s.stats.ingestNowPlaying(nowPlayingPayload({ listeners: 99, isOnline: false }));
    assert.equal(s.stats.state.totals.peak.value, 8); // offline sample ignored

    // ring cap
    for (let i = 0; i < 600; i++) {
      s.clockRef.t += 5 * 60_000;
      s.stats.ingestNowPlaying(nowPlayingPayload({ listeners: 1 }));
    }
    assert.ok(s.stats.state.min5.length <= 576);
  } finally {
    await s.close();
  }
});

// ---- 3. Timezone -------------------------------------------------------------

test('played_at 03:00 UTC buckets to the PREVIOUS station-TZ day; month key matches station TZ', async () => {
  const s = await withServer();
  try {
    // 2026-01-15T03:00:00Z = 2026-01-14T22:00:00-05:00 (ET, standard time).
    // isOnline:false so the live listener sample (bucketed at "now", i.e.
    // the withServer clock, a different calendar day) doesn't also touch
    // days[] and confuse this assertion — this test is about play bucketing.
    const ts = Date.parse('2026-01-15T03:00:00Z') / 1000;
    s.stats.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('x', ts), isOnline: false }));
    assert.ok(s.stats.state.days['2026-01-14']);
    assert.equal(s.stats.state.days['2026-01-14'].p, 1);
    assert.ok(!s.stats.state.days['2026-01-15']);
    assert.equal(s.stats.state.tracks['x'].m['2026-01'], 1);
  } finally {
    await s.close();
  }
});

// ---- 4. Backfill --------------------------------------------------------------

test('backfill: boundary freezes once, multiple windows execute, forward/over-return rows filtered, retry-safe, halts on shape mismatch, paginates', async () => {
  const s = await withServer({ backfillStart: '2026-01-01', apiKey: 'k' });
  try {
    // Seed forward state directly (bypassing ingestNowPlaying's hold-live
    // gate, which is exactly what's under test elsewhere — see the
    // "key-but-broken" case) to freeze the boundary at day 2026-01-25, far
    // enough out that this test's several 7-day windows have room to run.
    const boundaryTs = Date.parse('2026-01-25T17:00:00Z') / 1000; // noon ET
    seedForward(s, boundaryTs);

    const step1 = await s.stats.backfillStep(fakeFetchJson([])); // freezes boundary, no-op — no fetch/window work yet
    assert.equal(step1, true);
    const frozenBoundary = { ...s.stats.state.backfill.boundary };
    assert.ok(frozenBoundary.playedAt > 0);
    assert.equal(s.stats.state.backfill.cursor, null); // still uninitialized — freezing did no window work

    // A later forward advance must NOT move the (already-frozen) boundary —
    // checked below once the first real window step has also run.
    s.stats.state.watermark = { playedAt: boundaryTs + 3600, shId: 2 };

    // (b) window 1: 2026-01-01..01-08. In-window row (a) ingested; row (b)
    // is (d) an over-returning API row outside the requested window — filtered.
    const w1InWindow = row('bf-a', Date.parse('2026-01-02T17:00:00Z') / 1000, { shId: 100 });
    const w1OutOfWindow = row('bf-b', Date.parse('2026-01-20T17:00:00Z') / 1000, { shId: 101 });
    let more = await s.stats.backfillStep(fakeFetchJson([w1InWindow, w1OutOfWindow]));
    assert.equal(more, true);
    assert.deepEqual(s.stats.state.backfill.boundary, frozenBoundary); // never recomputed
    assert.equal(s.stats.state.backfill.cursor, '2026-01-09');
    assert.ok(s.stats.state.tracks['bf-a']);
    assert.ok(!s.stats.state.tracks['bf-b']); // outside requested window, filtered

    // (e)/(g) window 2 (2026-01-09..01-16): a non-OK response does not
    // advance the cursor, only records lastError.
    const errFetch = fakeFetchJson({ error: 'nope' }, false, 503);
    more = await s.stats.backfillStep(errFetch);
    assert.equal(more, true);
    assert.equal(s.stats.state.backfill.cursor, '2026-01-09'); // unmoved
    assert.ok(s.stats.state.backfill.lastError.includes('503'));

    // Retrying window 2 with the SAME row ingests it exactly once.
    const retryRow = row('bf-retry', Date.parse('2026-01-09T17:00:00Z') / 1000, { shId: 102 });
    await s.stats.backfillStep(fakeFetchJson([retryRow]));
    assert.equal(s.stats.state.tracks['bf-retry'].n, 1);
    assert.equal(s.stats.state.backfill.cursor, '2026-01-17'); // window 2 done, cursor moved to window 3

    // A duplicate re-delivery of the SAME row against the (now different,
    // window-3) request does not double-count: bf-retry's played_at
    // (2026-01-09) falls outside window 3's [2026-01-17, 2026-01-24] range,
    // so the numeric filter — not watermark dedupe — keeps it a no-op. This
    // is backfill's idempotence guarantee: replaying a response is only
    // safe because of the window-relative numeric filter, not because rows
    // are deduped by id.
    await s.stats.backfillStep(fakeFetchJson([retryRow]));
    assert.equal(s.stats.state.tracks['bf-retry'].n, 1);

    // (c) a row at/after boundary.playedAt is never ingested via backfill —
    // it belongs to the forward region.
    const atBoundary = row('bf-c', frozenBoundary.playedAt, { shId: 999 });
    await s.stats.backfillStep(fakeFetchJson([atBoundary]));
    assert.ok(!s.stats.state.tracks['bf-c']);

    // (f) done flips exactly when cursor passes boundary.day — drain the loop.
    let guard = 0;
    while (!s.stats.state.backfill.done && !s.stats.state.backfill.halted && guard < 200) {
      await s.stats.backfillStep(fakeFetchJson([]));
      guard += 1;
    }
    assert.equal(s.stats.state.backfill.done, true);
    assert.equal(s.stats.state.backfill.halted, false);
  } finally {
    await s.close();
  }
});

test('backfill: rowsSeen>0 with zero valid rows halts and freezes the cursor', async () => {
  const s = await withServer({ backfillStart: '2026-01-01', apiKey: 'k' });
  try {
    const boundaryTs = Date.parse('2026-01-10T17:00:00Z') / 1000;
    seedForward(s, boundaryTs);
    await s.stats.backfillStep(fakeFetchJson([])); // freeze boundary

    // cursor is still null here — the freeze-boundary step above did no
    // window work. This step is the first REAL window: cursor initializes
    // to backfillStart internally, then the shape mismatch halts before any
    // window advance, so it must freeze at exactly that initial value.
    assert.equal(s.stats.state.backfill.cursor, null);
    // Rows with no numeric played_at / no song id — shape mismatch.
    const junk = [{ garbage: true }, { played_at: 'not-a-number', song: {} }];
    const more = await s.stats.backfillStep(fakeFetchJson(junk));
    assert.equal(more, false);
    assert.equal(s.stats.state.backfill.halted, true);
    assert.equal(s.stats.state.backfill.lastError, 'shape mismatch');
    assert.equal(s.stats.state.backfill.cursor, '2026-01-01'); // frozen at its initial value

    // Further steps stay halted (require a reset to resume) and the cursor
    // stays frozen.
    const cursorAfterHalt = s.stats.state.backfill.cursor;
    const again = await s.stats.backfillStep(fakeFetchJson([]));
    assert.equal(again, false);
    assert.equal(s.stats.state.backfill.cursor, cursorAfterHalt);
  } finally {
    await s.close();
  }
});

test('backfill: a window that over-returns rows fully outside the numeric filter (e.g. the boundary window) does NOT halt', async () => {
  const s = await withServer({ backfillStart: '2026-01-01', apiKey: 'k' });
  try {
    const boundaryTs = Date.parse('2026-01-05T17:00:00Z') / 1000;
    seedForward(s, boundaryTs);
    await s.stats.backfillStep(fakeFetchJson([])); // freeze boundary at day 2026-01-05

    // Valid rows, but ALL at/after the boundary — should be filtered, not halted.
    const rows = [row('post', boundaryTs + 1000), row('post2', boundaryTs + 2000)];
    const more = await s.stats.backfillStep(fakeFetchJson(rows));
    assert.equal(more, true);
    assert.equal(s.stats.state.backfill.halted, false);
  } finally {
    await s.close();
  }
});

test('backfill: paginated envelope follows links.next and includes page-2 rows', async () => {
  const s = await withServer({ backfillStart: '2026-01-01', apiKey: 'k' });
  try {
    const boundaryTs = Date.parse('2026-01-20T17:00:00Z') / 1000;
    seedForward(s, boundaryTs);
    await s.stats.backfillStep(fakeFetchJson([])); // freeze boundary

    const page1Row = row('pg-1', Date.parse('2026-01-02T17:00:00Z') / 1000, { shId: 1 });
    const page2Row = row('pg-2', Date.parse('2026-01-03T17:00:00Z') / 1000, { shId: 2 });
    const nextUrl = 'http://x/next-page';
    const fetchImpl = async (url) => {
      if (url === nextUrl) {
        return { ok: true, status: 200, json: async () => ({ rows: [page2Row] }) };
      }
      return { ok: true, status: 200, json: async () => ({ rows: [page1Row], links: { next: nextUrl } }) };
    };
    await s.stats.backfillStep(fetchImpl);
    assert.ok(s.stats.state.tracks['pg-1']);
    assert.ok(s.stats.state.tracks['pg-2']);
  } finally {
    await s.close();
  }
});

test('backfill: never re-ingests rows syncRecent already covered (boundary is the forward FLOOR, not the head)', async () => {
  // Regression for a real double-count caught by the e2e smoke run: on boot,
  // syncRecent's first window spans ~2 days below the watermark head. If the
  // boundary froze from the HEAD, backfill's last windows would re-ingest
  // exactly those rows. It must freeze from coveredFrom (the forward floor).
  const s = await withServer({ backfillStart: '2026-01-01', apiKey: 'k', startMs: Date.parse('2026-01-15T17:00:00Z') });
  try {
    // Rows across three days; syncRecent's first run returns ALL of them
    // (generous window), establishing forward floor=r1, head=r3.
    const r1 = row('ov-1', Date.parse('2026-01-13T17:00:00Z') / 1000, { shId: 11 });
    const r2 = row('ov-2', Date.parse('2026-01-14T17:00:00Z') / 1000, { shId: 12 });
    const r3 = row('ov-3', Date.parse('2026-01-15T12:00:00Z') / 1000, { shId: 13 });
    await s.stats.tick(async (url) => {
      if (url.includes('/history')) return { ok: true, status: 200, json: async () => [r1, r2, r3] };
      return { ok: true, status: 200, json: async () => nowPlayingPayload({ nowPlaying: r3 }) };
    });
    assert.equal(s.stats.state.totals.plays, 3);
    assert.equal(s.stats.state.coveredFrom, r1.played_at);

    await s.stats.backfillStep(fakeFetchJson([])); // freeze — must pick the FLOOR
    assert.equal(s.stats.state.backfill.boundary.playedAt, r1.played_at);

    // Backfill windows now re-deliver the same rows (over-returning API).
    // None may double-count; older-than-floor rows DO count, exactly once.
    const older = row('ov-0', Date.parse('2026-01-05T17:00:00Z') / 1000, { shId: 10 });
    let guard = 0;
    while (!s.stats.state.backfill.done && guard < 20) {
      await s.stats.backfillStep(fakeFetchJson([older, r1, r2, r3]));
      guard += 1;
    }
    assert.equal(s.stats.state.backfill.done, true);
    assert.equal(s.stats.state.tracks['ov-0'].n, 1);
    assert.equal(s.stats.state.tracks['ov-1'].n, 1);
    assert.equal(s.stats.state.tracks['ov-2'].n, 1);
    assert.equal(s.stats.state.tracks['ov-3'].n, 1);
    assert.equal(s.stats.state.totals.plays, 4);
  } finally {
    await s.close();
  }
});

// ---- 5. Concurrency -----------------------------------------------------------

test('concurrent backfillStep calls: the second returns immediately via the busy guard, window ingested once', async () => {
  const s = await withServer({ backfillStart: '2026-01-01', apiKey: 'k' });
  try {
    const boundaryTs = Date.parse('2026-01-20T17:00:00Z') / 1000;
    seedForward(s, boundaryTs);
    await s.stats.backfillStep(fakeFetchJson([])); // freeze boundary

    let releaseFetch;
    const gate = new Promise((r) => { releaseFetch = r; });
    let fetchCalls = 0;
    const slowFetch = async () => {
      fetchCalls += 1;
      await gate;
      return { ok: true, status: 200, json: async () => [row('slow-1', Date.parse('2026-01-02T17:00:00Z') / 1000)] };
    };

    const first = s.stats.backfillStep(slowFetch);
    const second = s.stats.backfillStep(slowFetch); // fires while `first` is still pending
    const secondResult = await second;
    assert.equal(secondResult, true); // busy guard — no-op
    assert.equal(fetchCalls, 1); // second never actually fetched

    releaseFetch();
    await first;
    assert.equal(s.stats.state.tracks['slow-1'].n, 1); // ingested exactly once
  } finally {
    await s.close();
  }
});

// ---- 6. Key-but-broken --------------------------------------------------------

test('key-but-broken: history always 403 — after 3 failed sync attempts, live nowplaying plays accumulate anyway', async () => {
  const s = await withServer({ apiKey: 'bad-key' });
  try {
    const failingFetch = async (url) =>
      url.includes('/history') ? { ok: false, status: 403, json: async () => ({}) } : { ok: true, status: 200, json: async () => nowPlayingPayload({}) };

    // Drive 3 ticks, advancing the clock past SYNC_INTERVAL_MS (10 min)
    // between each so every tick re-attempts a sync (tick's 10-min gate
    // would otherwise skip attempts 2 and 3).
    for (let i = 0; i < 3; i++) {
      s.clockRef.t += 11 * 60_000;
      await s.stats.tick(async (url, options) => {
        if (url.includes('/history')) return failingFetch(url);
        return { ok: true, status: 200, json: async () => nowPlayingPayload({ nowPlaying: row(`held-${i}`, T_NOON + i, { shId: i }) }) };
      });
    }
    // 3 sync failures reached — live ingest should no longer be held.
    await s.stats.tick(async (url) => {
      if (url.includes('/history')) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => nowPlayingPayload({ nowPlaying: row('unheld', T_NOON + 999, { shId: 999 }) }) };
    });
    assert.ok(s.stats.state.tracks['unheld'], 'live play must accumulate once the escape hatch trips');
  } finally {
    await s.close();
  }
});

// ---- 7. Sync gap-fill -----------------------------------------------------------

test('syncRecent gap-fill: only rows newer than the watermark are ingested; a later live ingest of the same rows is a no-op', async () => {
  const s = await withServer({ apiKey: 'k' });
  try {
    // Establish watermark at T directly (apiKey is set, so a plain
    // ingestNowPlaying call would be held per the boot-gap ordering rule —
    // exercised separately in "key-but-broken" — not what this test covers).
    s.stats.state.watermark = { playedAt: T_NOON, shId: 5 };

    const before = row('too-old', T_NOON - 100, { shId: 1 });
    const gapRow = row('gap-1', T_NOON + 50, { shId: 6 });
    const dup = row('base', T_NOON, { shId: 5 }); // exact watermark row, must not double count

    const fetchImpl = async (url) => {
      if (url.includes('/history')) {
        return { ok: true, status: 200, json: async () => [before, dup, gapRow] };
      }
      return { ok: true, status: 200, json: async () => nowPlayingPayload({ nowPlaying: gapRow, history: [before, dup] }) };
    };

    await s.stats.tick(fetchImpl); // syncRecent ingests gapRow only, then live ingest of the same rows is a no-op
    assert.equal(s.stats.state.tracks['gap-1'].n, 1);
    assert.ok(!s.stats.state.tracks['too-old']);
    assert.equal(s.stats.state.watermark.playedAt, T_NOON + 50);
  } finally {
    await s.close();
  }
});

// ---- 8. Endpoints over HTTP -----------------------------------------------------

test('GET /stats/summary: dense days incl. zero-filled gap day, top lists sorted desc', async () => {
  const s = await withServer();
  try {
    const day1 = Date.parse('2026-01-10T17:00:00Z') / 1000;
    const day3 = Date.parse('2026-01-12T17:00:00Z') / 1000; // day2 (01-11) is a gap
    s.stats.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('pop-1', day1, { shId: 1, listeners: 20 }) }));
    s.stats.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('pop-1', day3, { shId: 2, listeners: 30 }) })); // same track again
    s.stats.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('pop-2', day3 + 10, { shId: 3, listeners: 10 }) }));

    const r = await fetch(`${s.base}/stats/summary`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.totals.plays, 3);
    const byDay = Object.fromEntries(body.days.map((d) => [d.d, d]));
    assert.ok(byDay['2026-01-10']);
    assert.ok(byDay['2026-01-11']); // zero-filled gap day present
    assert.equal(byDay['2026-01-11'].p, 0);
    assert.equal(byDay['2026-01-11'].lavg, null);
    assert.ok(byDay['2026-01-12']);
    assert.equal(body.topTracks[0].id, 'pop-1');
    assert.equal(body.topTracks[0].plays, 2);
    assert.ok(body.topTracks[0].plays >= body.topTracks[1].plays);
  } finally {
    await s.close();
  }
});

test('GET /stats/listeners: all-range emits d + nulls for uncovered days; 24h uses step 300', async () => {
  const s = await withServer();
  try {
    const day1 = Date.parse('2026-01-10T17:00:00Z') / 1000;
    s.stats.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('l-1', day1, { listeners: 12 }) }));
    // A live sample lands on 2026-01-12 (a day with no play-derived listener data of its own).
    s.clockRef.t = Date.parse('2026-01-12T18:00:00Z').valueOf();
    s.stats.ingestNowPlaying(nowPlayingPayload({ listeners: 7 }));

    const rAll = await fetch(`${s.base}/stats/listeners?range=all`);
    const bodyAll = await rAll.json();
    assert.equal(bodyAll.step, 86_400);
    const byDay = Object.fromEntries(bodyAll.points.map((p) => [p.d, p]));
    assert.ok('2026-01-11' in byDay);
    assert.equal(byDay['2026-01-11'].avg, null);
    assert.equal(byDay['2026-01-11'].max, null);
    assert.ok(byDay['2026-01-10'].avg !== null);

    const r24 = await fetch(`${s.base}/stats/listeners?range=24h`);
    const body24 = await r24.json();
    assert.equal(body24.step, 300);
    assert.ok(Array.isArray(body24.points));
  } finally {
    await s.close();
  }
});

test('GET /stats/track: 400 on bad id, 404 unknown, 200 known', async () => {
  const s = await withServer();
  try {
    s.stats.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('deadbeefcafef00d', T_NOON) }));

    const bad = await fetch(`${s.base}/stats/track?id=not-hex!!`);
    assert.equal(bad.status, 400);

    const missing = await fetch(`${s.base}/stats/track?id=0123456789abcdef`);
    assert.equal(missing.status, 404);

    const ok = await fetch(`${s.base}/stats/track?id=deadbeefcafef00d`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.track.id, 'deadbeefcafef00d');
    assert.equal(body.track.plays, 1);
    assert.ok(Array.isArray(body.track.months));
  } finally {
    await s.close();
  }
});

test('GET /stats/artist: case-insensitive lookup, 404 when absent', async () => {
  const s = await withServer();
  try {
    s.stats.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('a1', T_NOON, { artist: 'The Weeknd' }) }));

    const r = await fetch(`${s.base}/stats/artist?name=${encodeURIComponent('the weeknd')}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.artist.name, 'The Weeknd');
    assert.equal(body.artist.plays, 1);
    assert.ok(Array.isArray(body.artist.topTracks));

    const missing = await fetch(`${s.base}/stats/artist?name=nobody`);
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test('GET /stats/health shape', async () => {
  const s = await withServer();
  try {
    const r = await fetch(`${s.base}/stats/health`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.plays, 'number');
    assert.ok('coveredFrom' in body);
    assert.ok('backfill' in body && 'enabled' in body.backfill && 'done' in body.backfill && 'halted' in body.backfill);
  } finally {
    await s.close();
  }
});

test('unknown /stats/x falls through to 404 (proves the fallthrough wiring); POST /stats/summary also falls through', async () => {
  const s = await withServer();
  try {
    const r1 = await fetch(`${s.base}/stats/nope`);
    assert.equal(r1.status, 404);

    const r2 = await fetch(`${s.base}/stats/summary`, { method: 'POST' });
    assert.equal(r2.status, 404);
  } finally {
    await s.close();
  }
});

test('rate limiting: 429 past the per-IP cap', async () => {
  const s = await withServer({ rateLimitMax: 2 });
  try {
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${s.base}/stats/health`);
      codes.push(r.status);
    }
    assert.deepEqual(codes, [200, 200, 429, 429]);
  } finally {
    await s.close();
  }
});

// ---- 9. XSS ---------------------------------------------------------------------

test('XSS payloads in title/art are sanitized in storage AND in summary/track payloads (art -> \'\')', async () => {
  const s = await withServer();
  try {
    // A valid-looking hex song id — /stats/track validates the id shape.
    const id = 'deadbeefcafebabe';
    // sanitizeText (imported from index.mjs, real implementation) only
    // strips control chars + caps length — it does NOT HTML-escape; that is
    // deliberately the client's job via textContent (see CLAUDE.md / the
    // index.mjs sanitizeText comment). `art`, by contrast, is rendered into
    // <img src="…"> and MUST collapse attribute-breakout payloads to ''.
    const evilRow = row(id, T_NOON, {
      title: '"><img onerror=alert(1)>',
      artist: 'ok artist',
      art: 'x" onerror="alert(1)"',
    });
    s.stats.ingestNowPlaying(nowPlayingPayload({ nowPlaying: evilRow }));

    assert.equal(s.stats.state.tracks[id].art, '');

    const r = await fetch(`${s.base}/stats/track?id=${id}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.track.art, ''); // neutralised in the HTTP payload too

    const rs = await fetch(`${s.base}/stats/summary`);
    const summary = await rs.json();
    const top = summary.topTracks.find((t) => t.id === id);
    assert.ok(top);
    assert.equal(top.art, '');
  } finally {
    await s.close();
  }
});

// ---- 10. Persistence --------------------------------------------------------------

test('save() then a new createStats on the same path reloads state intact, incl. artistsIdx rebuilt from tracks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efm-stats-persist-'));
  const storePath = join(dir, 'stats.json');
  try {
    const clockRef = { t: Date.parse('2026-01-15T12:00:00Z') };
    const s1 = createStats({ storePath, timezone: TZ, sanitizeText, sanitizeArt, now: () => clockRef.t });
    s1.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('persist-1', T_NOON, { artist: 'Persisted Artist' }) }));
    s1.save();

    const s2 = createStats({ storePath, timezone: TZ, sanitizeText, sanitizeArt, now: () => clockRef.t });
    assert.equal(s2.state.totals.plays, 1);
    assert.equal(s2.state.tracks['persist-1'].a, 'Persisted Artist');

    // artistsIdx works via the HTTP layer after reload.
    const storeHandler = async (req, res) => { res.writeHead(404); res.end('{}'); };
    const server = createServer(async (req, res) => {
      const handled = await s2.handler(req, res);
      if (!handled) return storeHandler(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}/stats/artist?name=${encodeURIComponent('persisted artist')}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.artist.plays, 1);
    await new Promise((r2) => server.close(r2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt JSON on disk -> fresh state, no throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efm-stats-corrupt-'));
  const storePath = join(dir, 'stats.json');
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(storePath, '{ this is not json');
    assert.doesNotThrow(() => {
      const s = createStats({ storePath, timezone: TZ, sanitizeText, sanitizeArt });
      assert.equal(s.state.totals.plays, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('STATS_BACKFILL_RESET wipes plays but keeps listener rings + peak; applies once per token value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efm-stats-reset-'));
  const storePath = join(dir, 'stats.json');
  try {
    const clockRef = { t: Date.parse('2026-01-15T12:00:00Z') };
    const s1 = createStats({ storePath, timezone: TZ, sanitizeText, sanitizeArt, now: () => clockRef.t });
    s1.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('reset-1', T_NOON, { listeners: 15 }), listeners: 15 }));
    s1.save();
    assert.equal(s1.state.totals.plays, 1);
    const peakBefore = s1.state.totals.peak.value;
    assert.ok(peakBefore > 0);

    const s2 = createStats({ storePath, timezone: TZ, sanitizeText, sanitizeArt, now: () => clockRef.t, backfillReset: 'v1' });
    assert.equal(s2.state.totals.plays, 0);
    assert.equal(Object.keys(s2.state.tracks).length, 0);
    assert.equal(s2.state.totals.peak.value, peakBefore); // listener data survives
    assert.equal(s2.state.backfill.resetToken, 'v1');
    s2.ingestNowPlaying(nowPlayingPayload({ nowPlaying: row('reset-2', T_NOON + 10) }));
    s2.save();

    // Re-applying the SAME token again must be a no-op (already applied).
    const s3 = createStats({ storePath, timezone: TZ, sanitizeText, sanitizeArt, now: () => clockRef.t, backfillReset: 'v1' });
    assert.equal(s3.state.totals.plays, 1); // reset-2's play survives — not wiped again
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
