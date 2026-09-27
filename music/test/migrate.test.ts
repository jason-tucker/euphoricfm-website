// v0.2.1 deploy fixes (review deploy-F1 / F2), pure: the music_app password
// charset must survive DATABASE_URL, and the migrator's first connect is
// retried (bounded) only while the database is not reachable yet.
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { assertSafePassword, isTransientConnectError, waitForDatabase } from '@/migrate/main'

describe('music_app password (deploy-F1)', () => {
  it('accepts only URL-safe [A-Za-z0-9_.-]{24,128}: `openssl rand -hex 24` passes, base64 does not', () => {
    const hex = 'a3f9c2e1b4d5967880aa11bb22cc33dd44ee55ff66778899' // openssl rand -hex 24
    expect(assertSafePassword(hex)).toBe(hex)
    expect(assertSafePassword('test-only-app-password-000000')).toBe('test-only-app-password-000000')
    expect(assertSafePassword('A'.repeat(128))).toHaveLength(128)
    for (const bad of ['ab+cd/efGH0123456789xyz=', 'x'.repeat(23) + '/', 'x'.repeat(24) + '+', 'x'.repeat(24) + '=', 'x'.repeat(24) + '~', "x".repeat(24) + "'", 'x'.repeat(23), 'x'.repeat(129), '', undefined]) {
      expect(() => assertSafePassword(bad), String(bad)).toThrow(/openssl rand -hex 24/)
    }
  })

  it('every accepted password round-trips through the DATABASE_URL web and worker use', () => {
    for (const pw of ['a3f9c2e1b4d5967880aa11bb22cc33dd44ee55ff66778899', 'Az09_.-Az09_.-Az09_.-Az09_.-']) {
      const url = `postgres://music_app:${assertSafePassword(pw)}@music-db:5432/music`
      const opts = postgres(url).options
      expect(opts.pass).toBe(pw)
      expect(opts.user).toBe('music_app')
    }
    // What the old charset let through: a base64 value with '/' breaks the URL.
    expect(() => postgres('postgres://music_app:ab+cd/efGH0123456789xyz=@music-db:5432/music')).toThrow()
  })
})

describe('migrator connect retry (deploy-F2)', () => {
  const err = (code: string) => Object.assign(new Error(code), { code })
  const clock = () => {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => void (t += ms) }
  }

  it('retries transient connect errors until the database answers', async () => {
    const seen = [err('ECONNREFUSED'), err('57P03'), new AggregateError([err('ECONNREFUSED')], 'all addresses failed'), err('CONNECT_TIMEOUT')]
    const c = clock()
    const logs: string[] = []
    const attempts = await waitForDatabase(
      async () => {
        const e = seen.shift()
        if (e) throw e
        return 1
      },
      { ...c, log: (m) => logs.push(m) },
    )
    expect(attempts).toBe(5)
    expect(logs).toHaveLength(4)
    expect(c.now()).toBe(8_000)
  })

  it('gives up after about 60 s and rethrows the last error', async () => {
    const c = clock()
    let n = 0
    await expect(
      waitForDatabase(async () => {
        n++
        throw err('ECONNREFUSED')
      }, c),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(c.now()).toBeLessThanOrEqual(60_000)
    expect(n).toBe(31) // t = 0, 2, …, 60 s
  })

  it('fails at once on anything else (bad password, missing database, SQL errors)', async () => {
    for (const code of ['28P01', '3D000', '42601']) {
      const c = clock()
      let n = 0
      await expect(
        waitForDatabase(async () => {
          n++
          throw err(code)
        }, c),
      ).rejects.toMatchObject({ code })
      expect(n).toBe(1)
    }
    expect(isTransientConnectError(new Error('x'))).toBe(false)
    expect(isTransientConnectError(null)).toBe(false)
  })
})
