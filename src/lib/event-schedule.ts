// Pure helpers for the Euphoric Events station's public schedule feed
// (scripts/events.ts). No DOM, no config — imported straight from source by
// test/site-build.test.mjs (Node 24 strips the types).

export interface ScheduleEntry {
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
export const isValidEntry = (e: unknown): e is ScheduleEntry => {
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

// Event helper playlists (pinned songs, announcements) are named with a
// leading "~" on the station and run alongside the main event playlist.
// They are plumbing, not events — only the main event row is shown.
export const isHelperRow = (e: Pick<ScheduleEntry, 'name'>): boolean => e.name.trimStart().startsWith('~');

// A booking that crosses midnight comes back from the schedule API split
// into per-day rows (…–23:59, then 00:00–…). Rows of the SAME playlist
// whose gap is at most this many seconds are one event to a listener —
// merge them. 5 minutes comfortably covers the day-split seam without
// ever merging genuinely separate sessions hours apart.
export const MERGE_GAP_SEC = 300;

// Collapse contiguous/overlapping same-id rows into single events spanning
// the full range (is_now survives from any merged part). Exact duplicate
// rows merge too (zero/negative gap). Output is sorted by start.
export const mergeContiguous = (entries: ScheduleEntry[]): ScheduleEntry[] => {
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

// What the page shows: helper rows dropped, then midnight splits merged.
export const eventRows = (entries: ScheduleEntry[]): ScheduleEntry[] =>
  mergeContiguous(entries.filter((e) => !isHelperRow(e)));
