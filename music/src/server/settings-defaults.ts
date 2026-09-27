// Default runtime settings (plan §3.1). Seeded insert-if-absent by the
// migrator; admins edit them later. station_id is NOT a setting (worker env).

export const MB = 1024 * 1024

export const DEFAULT_CAPS = {
  maxUploadBytes: 35 * MB,
  chunkBytes: 8 * MB,
  maxInflightBytesPerUser: 1024 * MB,
  maxConcurrentUploadsPerUser: 3,
  maxStagingBytes: 5 * 1024 * MB,
  diskPausePercent: 85,
  maxItemsPerBatch: 20,
  ingestPerHour: 6,
  ingestSpacingS: 90,
} as const

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  assignable_playlist_ids: [2],
  default_playlist_ids: [2],
  // Every playlist id that belongs to STATION_ID. Listings aggregate
  // memberships across all stations on the storage (P0d-B (d)), so playlist
  // merges must filter by this set. SYNC-OWNED (worker/library/sync.ts
  // stationSet), read-only for admins; null until the first library sync.
  station_playlist_ids: null,
  // Playlist ids that belong to OTHER stations on storage 2: the Events
  // station 14 (from the live DB, station_playlists.station_id = 14: 74
  // Stinger, 75 ForeverStinger, 76 default, 77 Fasion Show (Test), 78
  // Renfair). The ADMIN control: the sync keeps these out of
  // station_playlist_ids, and a song in any of them is never archived.
  foreign_playlist_ids: [74, 75, 76, 77, 78],
  // Ids the sync counted as station 1 after first seeing them (alerted);
  // sync-owned. Only these (and ids outside the station set) may be added
  // to foreign_playlist_ids.
  unconfirmed_playlist_ids: [],
  auto_close_days: 7,
  caps: DEFAULT_CAPS,
  nowplaying_shortcode: 'euphoricfm',
  scan_end_offset_s: 10,
  queues_paused: null,
  // UI-facing settings (admin-editable via PUT /api/admin/settings).
  playlist_names: { '2': '1General Rotation' },
  rights_attestation: {
    version: '2026-09-27',
    text:
      'I own this recording, or I have permission from everyone who holds rights in it, to have it played on EuphoricFM. ' +
      'I understand managers can decline it, and that it can be removed from rotation later.',
  },
  discord_invite_url: null,
}

export type Caps = typeof DEFAULT_CAPS
