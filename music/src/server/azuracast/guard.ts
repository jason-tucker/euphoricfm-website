// Worker profile guard (plan §3.7 as amended 2026-09-27).
//
//  MUSIC_PROFILE  required, 'prod' | 'test'
//  STATION_ID     required, must be '1' in BOTH profiles (station 7 test key
//                 was dropped: "just use prod"; tests run under Portal-Test/)
//  PORTAL_TEST_PREFIX
//                 optional in prod (set for the first live verifications),
//                 REQUIRED in test; when set, every write path must start
//                 with it (enforced per call by the wrapper).
//
// Anything else refuses to start. The same check re-runs on every wrapper
// call against both the frozen config and the live process.env.

import { assertRoot, PathError } from '../paths/builder'

export class ProfileGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileGuardError'
  }
}

export type Profile = {
  profile: 'prod' | 'test'
  stationId: 1
  testPrefix: string // '' when unset
}

export const REQUIRED_STATION_ID = 1

export function resolveProfile(env: { MUSIC_PROFILE?: string; STATION_ID?: string; PORTAL_TEST_PREFIX?: string }): Profile {
  const profile = env.MUSIC_PROFILE
  if (profile !== 'prod' && profile !== 'test') {
    throw new ProfileGuardError(`MUSIC_PROFILE must be 'prod' or 'test' (got ${profile === undefined ? 'nothing' : JSON.stringify(profile)})`)
  }
  if (env.STATION_ID === undefined || !/^\d+$/.test(env.STATION_ID)) {
    throw new ProfileGuardError('STATION_ID is required')
  }
  const stationId = Number(env.STATION_ID)
  if (stationId !== REQUIRED_STATION_ID) {
    throw new ProfileGuardError(`${profile} profile requires STATION_ID=${REQUIRED_STATION_ID} (got ${stationId})`)
  }
  const prefix = env.PORTAL_TEST_PREFIX ?? ''
  if (prefix !== '') {
    try {
      assertRoot(prefix)
    } catch (e) {
      if (e instanceof PathError) throw new ProfileGuardError(`PORTAL_TEST_PREFIX invalid: ${JSON.stringify(prefix)}`)
      throw e
    }
  }
  if (profile === 'test' && prefix === '') {
    throw new ProfileGuardError('test profile requires PORTAL_TEST_PREFIX (the prefix guard must be active)')
  }
  return Object.freeze({ profile, stationId: REQUIRED_STATION_ID, testPrefix: prefix })
}

// Per-call re-assertion: the frozen profile must still be internally valid
// and must still match the live environment (a runtime env mutation — e.g.
// a dependency writing process.env — refuses every further call).
export type EnvLike = Record<string, string | undefined>

export function reassertProfile(p: Profile, env: EnvLike = process.env): void {
  const again = resolveProfile({ MUSIC_PROFILE: p.profile, STATION_ID: String(p.stationId), PORTAL_TEST_PREFIX: p.testPrefix })
  const live = resolveProfile(env)
  if (again.profile !== live.profile || again.stationId !== live.stationId || again.testPrefix !== live.testPrefix) {
    throw new ProfileGuardError('profile pairing changed at runtime')
  }
}
