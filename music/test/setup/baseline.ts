// Shared by the global setup (writes the baseline) and the per-file reset.

// The test stack's ingest pacing (settings.caps; production: 90 s, 6/hour).
export const TEST_PACING = { ingestSpacingS: 2, ingestPerHour: 1000 } as const

// Settings rows e2e files change (and restore in `finally`), put back to the
// global-setup state before every test file so a file that died mid-change
// cannot leak into the next one.
export const RESET_SETTING_KEYS = ['caps', 'soundcloud_fetch_enabled'] as const
