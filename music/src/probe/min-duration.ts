// The shortest audio the probe accepts. 30 s for the music portal (songs).
// PROBE_MIN_DURATION_S is an optional, probe-only override (an integer 1–30)
// so the events probe can accept short announcements (events-probe sets 3);
// it can only lower the floor, never raise it. It applies to uploads (MP3 and
// WAV); SoundCloud links (music only, fetched.ts) keep the fixed 30 s. The
// events worker still rejects a SONG under 30 s after its probe
// (events/worker/jobs/audio.ts audio_collect).

export const DEFAULT_MIN_DURATION_S = 30
export const PROBE_MIN_DURATION_ENV = 'PROBE_MIN_DURATION_S'

/** Parse the override; unset or empty → 30. Anything but an integer 1–30 throws. */
export function parseProbeMinDurationS(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_DURATION_S
  const t = raw.trim()
  const n = /^\d{1,2}$/.test(t) ? Number(t) : Number.NaN
  if (!Number.isInteger(n) || n < 1 || n > DEFAULT_MIN_DURATION_S) {
    throw new Error(`${PROBE_MIN_DURATION_ENV} must be an integer from 1 to ${DEFAULT_MIN_DURATION_S} (got ${JSON.stringify(raw)})`)
  }
  return n
}

/** The minimum the probe enforces (read from the environment each time). */
export function probeMinDurationS(env: Record<string, string | undefined> = process.env): number {
  return parseProbeMinDurationS(env[PROBE_MIN_DURATION_ENV])
}
