// Station-stats API types for EuphoricFM.
//
// These mirror the sidecar's /stats/* JSON payloads (server/stats.mjs, PART A
// of the stats spec) field-for-field — keep in sync if the server shape
// changes. Nothing here does I/O; stats.ts is the sole consumer.

export interface StatsDay {
  d: string; // 'YYYY-MM-DD', station TZ
  p: number; // plays
  r: number; // request-plays
  lavg: number | null; // avg listeners sampled that day, 1dp, null = no samples
  lmax: number | null;
}

export interface StatsHour {
  h: number; // 0..23, station TZ hour-of-day
  p: number;
  lavg: number | null;
}

export interface StatsDow {
  w: number; // 0..6, 0 = Sunday, station TZ
  p: number;
  lavg: number | null;
}

export interface StatsTopTrack {
  id: string;
  title: string;
  artist: string;
  art: string;
  plays: number;
  requests: number;
  firstAt: number; // unix seconds
  lastAt: number;
}

export interface StatsTopArtist {
  name: string;
  plays: number;
  requests: number;
  tracks: number;
}

export type BackfillState = 'none' | 'running' | 'done' | 'halted';

// Per-range rollup (PART S T1) — month-floored windows, since per-track
// history is only month-granular. Shapes mirror the root topTracks/topArtists
// entries closely on purpose (the client's list renderer is shared), but the
// range variants are deliberately slimmer: no firstAt/lastAt (not meaningful
// once the list is windowed) and `requests` is sourced from the ALL-TIME
// per-track/artist count (cheap, still useful) rather than a windowed sum —
// see server/stats.mjs for the comment. The KPI requests tile never reads
// this; it sums StatsDay.r over the window instead, which is exact.
export type StatsRangeKey = '7d' | '30d' | '90d' | '1y';

export interface StatsRangeTopTrack {
  id: string;
  title: string;
  artist: string;
  art: string;
  plays: number; // Σ months >= sinceMonth
  requests: number; // all-time, not windowed — see note above
}

export interface StatsRangeTopArtist {
  name: string;
  plays: number;
  requests: number;
  tracks: number;
}

export interface StatsRangeRollup {
  sinceMonth: string; // 'YYYY-MM', station TZ — the honest floor for the window label
  uniqueTracks: number;
  uniqueArtists: number;
  topTracks: StatsRangeTopTrack[]; // top 25 by windowed plays
  topArtists: StatsRangeTopArtist[]; // top 25 by windowed plays
}

// Day-of-week × hour rhythm grid (PART S T3), index = dow*24 + hour, always
// 168 entries (a store that predates the grid emits it zero-filled — that's
// exactly why the frontend keeps the marginal-strip fallback, see stats.ts).
export interface StatsGridCell {
  w: number; // 0..6, 0 = Sunday, station TZ
  h: number; // 0..23, station TZ hour-of-day
  p: number; // plays landing in this day×hour cell, all-time
  lavg: number | null; // avg listeners folded into this cell, null = no samples
}

export interface StatsSummary {
  ok: true;
  meta: {
    generatedAt: number;
    timezone: string;
    coverage: {
      from: number | null;
      to: number | null;
      backfill: BackfillState;
    };
  };
  totals: {
    plays: number;
    requests: number;
    uniqueTracks: number;
    uniqueArtists: number;
    peakListeners: { value: number; at: number };
    firstPlayAt: number | null;
    lastPlayAt: number | null;
  };
  // Dense ascending series, day(coveredFrom) → day(now, station TZ).
  days: StatsDay[];
  hours: StatsHour[];
  dow: StatsDow[];
  topTracks: StatsTopTrack[];
  topArtists: StatsTopArtist[];
  ranges: Record<StatsRangeKey, StatsRangeRollup>;
  grid: StatsGridCell[]; // always 168 entries, see StatsGridCell
}

export interface ListenersPoint {
  // Exactly one of t/d is present depending on range — see ListenersSeries.step.
  t?: number; // unix seconds bucket start (24h/7d/30d ranges)
  d?: string; // 'YYYY-MM-DD' bucket (all range) — label from this, never from a derived timestamp
  avg: number | null;
  max: number | null;
}

export type ListenersRange = '24h' | '7d' | '30d' | 'all';

export interface ListenersSeries {
  ok: true;
  range: ListenersRange;
  step: number; // seconds per bucket: 300 | 3600 | 86400
  points: ListenersPoint[];
}

export interface TrackDetailMonth {
  m: string; // 'YYYY-MM', station TZ
  p: number;
}

export interface TrackDetail {
  id: string;
  title: string;
  artist: string;
  art: string;
  plays: number;
  requests: number;
  firstAt: number;
  lastAt: number;
  months: TrackDetailMonth[]; // ascending
}

export interface TrackDetailResponse {
  ok: true;
  track: TrackDetail;
}

export interface ArtistTopTrack {
  id: string;
  title: string;
  art: string;
  plays: number;
}

export interface ArtistDetail {
  name: string;
  plays: number;
  requests: number;
  tracks: number;
  firstAt: number;
  lastAt: number;
  months: TrackDetailMonth[]; // ascending
  topTracks: ArtistTopTrack[]; // top 20
}

export interface ArtistDetailResponse {
  ok: true;
  artist: ArtistDetail;
}
