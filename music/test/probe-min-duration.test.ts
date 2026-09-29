// PROBE_MIN_DURATION_S: the optional probe-only floor override (the events
// probe sets 3 for short announcements). Unset keeps the music rule (30 s).
// Pure: no ffmpeg, no DB.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MIN_DURATION_S, parseProbeMinDurationS, probeMinDurationS } from '@/probe/min-duration'
import { judgeFfprobe, MIN_DURATION_S } from '@/probe/probe'
import { MIN_WAV_DURATION_S } from '@/probe/wav'

const mp3 = (duration: string) => ({ format: { format_name: 'mp3', duration, bit_rate: '192000' }, streams: [{ codec_type: 'audio', codec_name: 'mp3', bit_rate: '192000' }] })

afterEach(() => vi.unstubAllEnvs())

describe('probe minimum duration', () => {
  it('defaults to the music rule (30 s) and the exported constants are unchanged', () => {
    expect(DEFAULT_MIN_DURATION_S).toBe(30)
    expect(MIN_DURATION_S).toBe(30)
    expect(MIN_WAV_DURATION_S).toBe(30)
    expect(parseProbeMinDurationS(undefined)).toBe(30)
    expect(parseProbeMinDurationS('')).toBe(30)
    expect(probeMinDurationS({})).toBe(30)
  })

  it('accepts an integer 1–30 and refuses anything else', () => {
    expect(parseProbeMinDurationS('3')).toBe(3)
    expect(parseProbeMinDurationS(' 1 ')).toBe(1)
    expect(parseProbeMinDurationS('30')).toBe(30)
    for (const bad of ['0', '31', '300', '-3', '3.5', '3s', 'abc', '1e1']) expect(() => parseProbeMinDurationS(bad), bad).toThrow(/PROBE_MIN_DURATION_S/)
  })

  it('the probe judge enforces it: 5 s is too short by default, accepted with PROBE_MIN_DURATION_S=3', () => {
    vi.stubEnv('PROBE_MIN_DURATION_S', '')
    expect(() => judgeFfprobe(mp3('5'))).toThrow('too_short')
    expect(() => judgeFfprobe(mp3('29.9'))).toThrow('too_short')
    expect(judgeFfprobe(mp3('30')).durationS).toBe(30)
    vi.stubEnv('PROBE_MIN_DURATION_S', '3')
    expect(judgeFfprobe(mp3('5')).durationS).toBe(5)
    expect(() => judgeFfprobe(mp3('2.9'))).toThrow('too_short')
    vi.stubEnv('PROBE_MIN_DURATION_S', '45')
    expect(() => judgeFfprobe(mp3('60'))).toThrow(/PROBE_MIN_DURATION_S/)
  })
})
