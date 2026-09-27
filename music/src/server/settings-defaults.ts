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
  // merges must filter by this set. Must be configured before P4 merges.
  station_playlist_ids: null,
  auto_close_days: 7,
  caps: DEFAULT_CAPS,
  nowplaying_shortcode: 'euphoricfm',
  scan_end_offset_s: 10,
  queues_paused: null,
}

export type Caps = typeof DEFAULT_CAPS
