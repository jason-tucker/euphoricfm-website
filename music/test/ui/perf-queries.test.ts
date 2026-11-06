// v0.4.1 (A8): query counts. The UI settings are one SELECT (was one per
// key: 12 for an anonymous GET /), and authenticating takes the user from the
// session instead of re-reading the users row. The database is a counting
// fake; nothing else is mocked below the function under test.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const counts = vi.hoisted(() => ({ select: 0, usersFindFirst: 0, session: null as null | { user: Record<string, unknown> } }))
const settingRows = vi.hoisted(() => ({ rows: [] as { key: string; value: unknown }[] }))

// select().from(settings).where(...) → the rows; select().from(roleBindings) → []
function fakeDb() {
  return {
    select: () => {
      counts.select++
      return {
        from: () => {
          const rows = settingRows.rows
          const q = Promise.resolve([]) as Promise<unknown[]> & { where?: unknown }
          q.where = async () => rows
          return q
        },
      }
    },
    query: {
      users: {
        findFirst: async () => {
          counts.usersFindFirst++
          return { id: 'u1', discordId: '100000000000000001', name: 'From DB' }
        },
      },
    },
  }
}

vi.mock('@/server/db/client', () => ({ getDb: () => fakeDb() }))
vi.mock('@/server/auth/config', () => ({ auth: async () => counts.session, membershipDeps: () => ({ now: () => Date.now() }) }))
vi.mock('@/server/auth/membership', () => ({
  TTL_MS: { member: 600_000, elevated: 60_000 },
  ensureFreshMembership: async () => ({ member: true, pending: false, roleIds: [], checkedAt: new Date(), source: 'discord' }),
}))
vi.mock('@/server/env', () => ({ webEnv: () => ({ PORTAL_OWNER_IDS: '' }) }))

beforeEach(() => {
  counts.select = 0
  counts.usersFindFirst = 0
  counts.session = null
  settingRows.rows = []
})

describe('uiSettings: one settings query (A8)', async () => {
  const { uiSettings } = await import('@/server/ui/settings')
  const { DEFAULT_CAPS } = await import('@/server/settings-defaults')

  it('reads every key in one SELECT and applies the same validation as before', async () => {
    settingRows.rows = [
      { key: 'playlist_names', value: { '31': 'Tea Time' } },
      { key: 'caps', value: { maxItemsPerBatch: 5, maxUploadBytes: 1 } },
      { key: 'soundcloud_fetch_enabled', value: false },
      { key: 'request_daily_caps', value: { edit: 3, removal: 2 } },
      { key: 'auto_close_days', value: 4 },
      { key: 'discord_invite_url', value: 'https://evil.example/x' },
    ]
    const s = await uiSettings(fakeDb() as never)
    expect(counts.select).toBe(1)
    expect(s.playlistNames).toEqual({ '2': 'General Rotation', '31': 'Tea Time' })
    expect(s.caps.maxItemsPerBatch).toBe(5)
    expect(s.caps.maxUploadBytes).toBe(DEFAULT_CAPS.maxUploadBytes) // hard limit: a stored value is ignored
    expect(s.soundcloudEnabled).toBe(false)
    expect(s.requestCaps).toEqual({ edit: 3, removal: 2 })
    expect(s.autoCloseDays).toBe(4)
    expect(s.inviteUrl).toBeNull()
  })

  it('no rows: the defaults (SoundCloud on, 10 / 10 requests, General Rotation)', async () => {
    const s = await uiSettings(fakeDb() as never)
    expect(s.soundcloudEnabled).toBe(true)
    expect(s.requestCaps).toEqual({ edit: 10, removal: 10 })
    expect(s.playlistNames).toEqual({ '2': 'General Rotation' })
    expect(s.assignablePlaylistIds).toEqual([2])
  })
})

describe('authentication reads the user from the session (A8)', async () => {
  const { currentUser, requirePermission } = await import('@/server/authz/viewer')

  it('a session carrying the user: no users read, one role-bindings read', async () => {
    counts.session = { user: { id: 'u1', discordId: '100000000000000001', name: 'Mia' } }
    expect(await currentUser()).toEqual({ id: 'u1', discordId: '100000000000000001', name: 'Mia' })
    const v = await requirePermission('submit')
    expect(v).toMatchObject({ userId: 'u1', discordId: '100000000000000001', name: 'Mia' })
    expect(v.perms.has('submit')).toBe(true)
    expect(counts.usersFindFirst).toBe(0)
    expect(counts.select).toBe(1)
  })

  it('a session without the Discord id (older cookie): exactly one users read per request', async () => {
    counts.session = { user: { id: 'u1' } }
    expect(await requirePermission('submit')).toMatchObject({ userId: 'u1', discordId: '100000000000000001', name: 'From DB' })
    expect(counts.usersFindFirst).toBe(1)
  })

  it('no session: 401 without touching the database', async () => {
    await expect(requirePermission('submit')).rejects.toMatchObject({ status: 401 })
    expect(counts.usersFindFirst + counts.select).toBe(0)
  })
})
