// Client-side driver for EventStatus.astro's live on-air card + "On the
// Calendar" list on /events.
//
// Source of truth is the dedicated Euphoric Events AzuraCast station
// (shortcode `event`, config: site.events.station) — a PUBLIC,
// unauthenticated, CORS-open schedule endpoint (verified
// access-control-allow-origin: *), fetched cross-origin exactly like
// nowplaying.ts fetches the main station's now-playing endpoint. No API key,
// no Caddyfile change.
//
// Progressive enhancement, same spirit as stats.ts: this script ships on
// every page via BaseLayout, so it early-bails when #evst-card (only on
// /events) is absent. All failures are silent (console.warn) and leave
// whatever the page already had on screen — first-load failure leaves the
// server-rendered off-air empty state exactly as it renders. Manual config
// override (`site.events.status.current` non-null) stamps
// `data-override="1"` on #evst-card (see EventStatus.astro); this script
// bails on that too — config always wins over the live feed.
//
// ALL dynamic strings (schedule names/times) reach the DOM via textContent
// only, never innerHTML — schedule names are staff-authored in-universe
// event names (e.g. "Fasion Show" — spelling is theirs) and render verbatim.

import { site } from '../site.config';

interface ScheduleEntry {
  id: number;
  type: 'playlist' | 'streamer';
  name: string;
  title: string;
  description: string;
  start_timestamp: number; // unix seconds
  start: string;
  end_timestamp: number; // unix seconds
  end: string;
  is_now: boolean;
}

// Guards against a malformed row (missing/mistyped field) before it reaches
// date math or textContent — cheap insurance against a schema drift on the
// upstream station without crashing the whole render.
const isValidEntry = (e: unknown): e is ScheduleEntry => {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  return (
    (typeof r.id === 'number' || typeof r.id === 'string') &&
    typeof r.name === 'string' &&
    typeof r.start_timestamp === 'number' &&
    typeof r.end_timestamp === 'number' &&
    typeof r.is_now === 'boolean'
  );
};

(() => {
  const elCard = document.getElementById('evst-card');
  if (!elCard) return; // ships on every page via BaseLayout; only /events has the markup

  if (elCard.dataset.override === '1') return; // config wins — see EventStatus.astro

  const elOffair = document.getElementById('evst-offair');
  const elOnair = document.getElementById('evst-onair');
  const elCalendar = document.getElementById('evst-calendar');
  const elCalendarList = document.getElementById('evst-calendar-list');
  if (!elOffair || !elOnair || !elCalendar || !elCalendarList) return;

  const elOnName = document.getElementById('evst-on-name');
  const elOnTimes = document.getElementById('evst-on-times');

  const s = site.events;
  const st = s.station;
  const tz = st.timezone;

  // Display cap for "On the Calendar" — a fixed UI constant, independent of
  // `station.scheduleRows` (how many raw rows are fetched from the API).
  const CALENDAR_LIMIT = 5;

  // A booking that crosses midnight comes back from the schedule API split
  // into per-day rows (…–23:59, then 00:00–…). Rows of the SAME playlist
  // whose gap is at most this many seconds are one event to a listener —
  // merge them. 5 minutes comfortably covers the day-split seam without
  // ever merging genuinely separate sessions hours apart.
  const MERGE_GAP_SEC = 300;

  // Collapse contiguous/overlapping same-id rows into single events spanning
  // the full range (is_now survives from any merged part). Exact duplicate
  // rows merge too (zero/negative gap). Output is sorted by start.
  const mergeContiguous = (entries: ScheduleEntry[]): ScheduleEntry[] => {
    const sorted = entries
      .slice()
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : a.start_timestamp - b.start_timestamp));
    const out: ScheduleEntry[] = [];
    for (const e of sorted) {
      const prev = out[out.length - 1];
      if (prev && String(prev.id) === String(e.id) && e.start_timestamp - prev.end_timestamp <= MERGE_GAP_SEC) {
        if (e.end_timestamp > prev.end_timestamp) {
          prev.end_timestamp = e.end_timestamp;
          prev.end = e.end;
        }
        if (e.is_now) prev.is_now = true;
        continue;
      }
      out.push({ ...e });
    }
    return out.sort((a, b) => a.start_timestamp - b.start_timestamp);
  };

  // ---- date/time formatting (station timezone, undefined locale — same
  // convention as stats.ts) --------------------------------------------------

  // 'YYYY-MM-DD' for a Date in the station timezone — read via formatToParts
  // rather than trusting a locale's default string shape.
  const stationISODate = (d: Date): string => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '01';
    return `${get('year')}-${get('month')}-${get('day')}`;
  };

  const dayLabel = (startMs: number, nowMs: number): string => {
    const startISO = stationISODate(new Date(startMs));
    if (startISO === stationISODate(new Date(nowMs))) return s.calendar.today;
    if (startISO === stationISODate(new Date(nowMs + 86400000))) return s.calendar.tomorrow;
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(startMs));
  };

  const timeOfDay = (ms: number): string =>
    new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

  // En dash to match EventStatus.astro's existing `&ndash;` between the
  // config-driven current-event times.
  const timeRange = (startSec: number, endSec: number): string =>
    `${timeOfDay(startSec * 1000)} – ${timeOfDay(endSec * 1000)}`;

  // ---- fetch ---------------------------------------------------------------

  const fetchSchedule = async (): Promise<ScheduleEntry[] | null> => {
    try {
      const url = `${st.apiBase}/station/${st.stationId}/schedule?rows=${st.scheduleRows}`;
      const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const data: unknown = await r.json();
      return Array.isArray(data) ? data.filter(isValidEntry) : null;
    } catch (err) {
      console.warn('[efm] events schedule fetch failed', err);
      return null;
    }
  };

  // ---- render ----------------------------------------------------------------

  const render = (rawEntries: ScheduleEntry[]) => {
    const nowSec = Date.now() / 1000;
    // Merge FIRST: an on-air event whose second (post-midnight) half is still
    // "upcoming" must read as one broadcast with the full time range — never
    // an ON AIR card plus a duplicate calendar row.
    const entries = mergeContiguous(rawEntries);
    const onAir = entries.find((e) => e.is_now === true && e.end_timestamp > nowSec) ?? null;

    elOffair!.classList.toggle('hidden', !!onAir);
    elOnair!.classList.toggle('hidden', !onAir);
    if (onAir) {
      if (elOnName) elOnName.textContent = onAir.name;
      if (elOnTimes) elOnTimes.textContent = timeRange(onAir.start_timestamp, onAir.end_timestamp);
    }

    // Upcoming: strictly future starts, excluding the entry shown as on-air,
    // ascending, exact-duplicate rows (recurring playlists share an id)
    // collapsed by id+start.
    const seen = new Set<string>();
    const upcoming: ScheduleEntry[] = [];
    for (const e of entries) {
      if (e.start_timestamp <= nowSec) continue;
      if (onAir && e.id === onAir.id && e.start_timestamp === onAir.start_timestamp) continue;
      const key = `${e.id}|${e.start_timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      upcoming.push(e);
    }
    upcoming.sort((a, b) => a.start_timestamp - b.start_timestamp);
    const shown = upcoming.slice(0, CALENDAR_LIMIT);

    if (shown.length === 0) {
      elCalendar!.classList.add('hidden');
      elCalendarList!.innerHTML = ''; // static clear — no dynamic string involved
      return;
    }
    elCalendar!.classList.remove('hidden');
    elCalendarList!.innerHTML = ''; // rebuilt fresh below
    const nowMs = Date.now();
    shown.forEach((e) => {
      const li = document.createElement('li');
      li.className = 'flex items-center justify-between gap-3 min-h-[48px] py-2 border-t border-cream/5 first:border-t-0';

      const nameEl = document.createElement('div');
      nameEl.className = 'min-w-0 flex-1 truncate text-sm font-semibold text-cream';
      nameEl.textContent = e.name;

      const meta = document.createElement('div');
      meta.className = 'shrink-0 text-right';
      const dayEl = document.createElement('div');
      dayEl.className = 'text-xs text-cream/60';
      dayEl.textContent = dayLabel(e.start_timestamp * 1000, nowMs);
      const timeEl = document.createElement('div');
      timeEl.className = 'text-xs text-cream/60';
      timeEl.textContent = timeRange(e.start_timestamp, e.end_timestamp);
      meta.appendChild(dayEl);
      meta.appendChild(timeEl);

      li.appendChild(nameEl);
      li.appendChild(meta);
      elCalendarList!.appendChild(li);
    });
  };

  // ---- poll/visibility (mirrors nowplaying.ts's start/stop pattern) --------

  const refresh = async () => {
    const data = await fetchSchedule();
    if (!data) return; // silent failure — page keeps whatever state it had
    render(data);
  };

  let pollHandle: number | null = null;
  const startPolling = () => {
    if (pollHandle != null) return;
    pollHandle = window.setInterval(refresh, st.pollMs);
  };
  const stopPolling = () => {
    if (pollHandle != null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refresh();
      startPolling();
    } else {
      stopPolling();
    }
  });

  refresh();
  startPolling();
})();
