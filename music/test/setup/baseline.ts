// Shared by the global setup (writes the baseline) and the per-file reset.

// The test stack's ingest pacing (settings.caps; production: 90 s, 6/hour).
export const TEST_PACING = { ingestSpacingS: 2, ingestPerHour: 1000 } as const

// Settings rows test files change (and restore in `finally` / afterAll), put
// back to the global-setup state before every test file so a file that died
// mid-change cannot leak into the next one. A key with no row at the global
// setup (the events_* switches: the product defaults apply) is deleted.
export const RESET_SETTING_KEYS = [
  'caps',
  'soundcloud_fetch_enabled',
  'assignable_playlist_ids',
  'events_enabled',
  'events_uploads_enabled',
  'events_autobuild_enabled',
  'events_member_daily_creates',
  'events_gap_min',
  'events_pin_strategy',
] as const
