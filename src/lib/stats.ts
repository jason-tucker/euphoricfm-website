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
