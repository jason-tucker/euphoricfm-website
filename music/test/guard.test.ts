import { describe, expect, it } from 'vitest'
import { reassertProfile, resolveProfile, ProfileGuardError } from '@/server/azuracast/guard'

describe('worker profile guard (plan §3.7, amended)', () => {
  it('refuses a missing or unknown MUSIC_PROFILE', () => {
    expect(() => resolveProfile({ STATION_ID: '1' })).toThrow(/MUSIC_PROFILE must be/)
    expect(() => resolveProfile({ MUSIC_PROFILE: '', STATION_ID: '1' })).toThrow(ProfileGuardError)
    expect(() => resolveProfile({ MUSIC_PROFILE: 'staging', STATION_ID: '1' })).toThrow(ProfileGuardError)
  })

  it('requires STATION_ID=1 in both profiles', () => {
    expect(() => resolveProfile({ MUSIC_PROFILE: 'prod' })).toThrow(/STATION_ID is required/)
    expect(() => resolveProfile({ MUSIC_PROFILE: 'prod', STATION_ID: '7' })).toThrow(/requires STATION_ID=1/)
    expect(() => resolveProfile({ MUSIC_PROFILE: 'test', STATION_ID: '7', PORTAL_TEST_PREFIX: 'Portal-Test/' })).toThrow(/requires STATION_ID=1/)
    expect(() => resolveProfile({ MUSIC_PROFILE: 'prod', STATION_ID: '01x' })).toThrow(ProfileGuardError)
  })

  it('test profile requires the prefix guard to be active', () => {
    expect(() => resolveProfile({ MUSIC_PROFILE: 'test', STATION_ID: '1' })).toThrow(/requires PORTAL_TEST_PREFIX/)
    expect(resolveProfile({ MUSIC_PROFILE: 'test', STATION_ID: '1', PORTAL_TEST_PREFIX: 'Portal-Test/' })).toEqual({
      profile: 'test',
      stationId: 1,
      testPrefix: 'Portal-Test/',
    })
  })

  it('validates the prefix itself', () => {
    for (const bad of ['Music/', '../', 'Portal-Test', 'Portal-Test/../', '/', 'Removed/', 'Portal Test/']) {
      expect(() => resolveProfile({ MUSIC_PROFILE: 'prod', STATION_ID: '1', PORTAL_TEST_PREFIX: bad }), bad).toThrow(ProfileGuardError)
    }
  })

  it('prod with or without the live-verification prefix', () => {
    expect(resolveProfile({ MUSIC_PROFILE: 'prod', STATION_ID: '1' }).testPrefix).toBe('')
    expect(resolveProfile({ MUSIC_PROFILE: 'prod', STATION_ID: '1', PORTAL_TEST_PREFIX: 'Portal-Test/' }).testPrefix).toBe('Portal-Test/')
  })

  it('per-call re-assertion notices a runtime env change', () => {
    const env = { MUSIC_PROFILE: 'prod', STATION_ID: '1', PORTAL_TEST_PREFIX: 'Portal-Test/' }
    const p = resolveProfile(env)
    expect(() => reassertProfile(p, env)).not.toThrow()
    expect(() => reassertProfile(p, { ...env, PORTAL_TEST_PREFIX: '' })).toThrow(/changed at runtime/)
    expect(() => reassertProfile(p, { ...env, STATION_ID: '7' })).toThrow(ProfileGuardError)
    expect(() => reassertProfile(p, { ...env, MUSIC_PROFILE: 'test' })).toThrow(/changed at runtime/)
  })
})
