// Default runtime settings (plan §3.1). Seeded insert-if-absent by the
// migrator; admins edit them later. station_id is NOT a setting (worker env).

export const MB = 1024 * 1024

export const DEFAULT_CAPS = {
  // The FINAL-file cap (35 MB): the MP3 the portal ships to AzuraCast, cover
  // and tags included (src/lib/fit.ts). Compiled in, not an upload limit
  // since v0.3.5, and never read from settings.caps (loadCaps).
  maxUploadBytes: 35 * MB,
  // v0.3.5: MP3 uploads (an MP3 too big to fit is re-encoded down by the
  // probe). Like the WAV cap below: tus creation caps by the DECLARED type,
  // the probe again by the ACTUAL type; admins may lower it (never above
  // 100 MB). A distinct key, so the stale maxUploadBytes (35 MB) stored in
  // production's caps row cannot keep the submit page at 35 MB.
  maxMp3UploadBytes: 100 * MB,
  // v0.3.0: WAV uploads (converted to a CBR MP3 by the probe). The tus
  // creation caps by the DECLARED type (Upload-Metadata filetype), the probe
  // again by the ACTUAL type; admins may lower it (never above 250 MB).
  maxWavUploadBytes: 250 * MB,
  chunkBytes: 8 * MB,
  maxInflightBytesPerUser: 1024 * MB,
  maxConcurrentUploadsPerUser: 3,
  maxStagingBytes: 5 * 1024 * MB,
  diskPausePercent: 85,
  maxItemsPerBatch: 20,
  ingestPerHour: 6,
  ingestSpacingS: 90,
  // Standalone album art (v0.2.1, review SEC-2). Charged at the uploaded
  // size while processing and while the probe's JPEG is kept (ready, 7 days),
  // and those bytes also count toward maxStagingBytes (same disk). Per user:
  // uploads and bytes in any rolling 24 h; globally: processing + ready bytes.
  artUploadsPerUserPerDay: 30,
  artBytesPerUserPerDay: 50 * MB,
  maxArtBytes: 512 * MB,
  // v0.4.0: SoundCloud links per member in any rolling 24 h (lowerable).
  fetchesPerUserPerDay: 20 as number,
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
  playlist_names: { '2': 'General Rotation' },
  rights_attestation: {
    version: '2026-09-27',
    text:
      'I own this recording, or I have permission from everyone who holds rights in it, to have it played on EuphoricFM. ' +
      'I understand managers can decline it, and that it can be removed from rotation later.',
  },
  discord_invite_url: null,
  // v0.4.0 kill switch for "Add from a SoundCloud link" (admin settings). Off:
  // the web refuses new links (503 sc_disabled) and the worker refuses to
  // send queued ones to music-fetch (the item is rejected sc_disabled).
  soundcloud_fetch_enabled: true,
}

export type Caps = typeof DEFAULT_CAPS
