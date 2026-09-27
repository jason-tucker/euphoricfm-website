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
  // Playlist ids that belong to OTHER stations on storage 2 (the Events
  // station 14; P0d-B (d) saw 74, 75, 77, 78 on station-1 files). The library
  // sync records station_playlist_ids = ids seen on Music/Artists/** minus
  // these, plus the assignable/default ids. Confirm against the DB
  // (station_playlists.station_id) before removing PORTAL_TEST_PREFIX.
  foreign_playlist_ids: [74, 75, 77, 78],
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
