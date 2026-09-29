// v0.5.0 events: the music-side edits at the DB level — uploads.site
// stamping + the events staging budget + in-flight counting of event_audio
// (uploads/caps.ts), per-site sweepers (uploads/retention.ts,
// art/retention.ts), the library sync's registry foreign set, the events
// settings module, and the locked Discord token refresh (auth/membership.ts).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getEventsSettings, loadEventsSettings, putEventsSettings } from '@/server/admin/events-settings'
import { sweepArt } from '@/server/art/retention'
import { ensureFreshMembership, type MembershipDeps } from '@/server/auth/membership'
import { encryptAccountTokens, loadDiscordTokens } from '@/server/auth/tokens'
import type { Viewer } from '@/server/authz/predicates'
import { closeDb, getDb } from '@/server/db/client'
import { DEFAULT_CAPS, MB } from '@/server/settings-defaults'
import { admitUpload, siteStagedBytes } from '@/server/uploads/caps'
import { sweepStaging } from '@/server/uploads/retention'
import { addUploadToBatch, createBatch } from '@/server/submissions'
import { eventRegistryPlaylistIds } from '@/worker/library/sync'
import { PgEventsStore } from '@/events/worker/store-pg'
import { ownerSql } from './helpers/db'
import { DBENV } from './helpers/env'
import { mkUser } from './helpers/p3'

process.env.APP_ENC_KEY ??= '0'.repeat(64)

const db = () => getDb(process.env.TEST_APP_DATABASE_URL, 2)
const hex = () => randomUUID().replace(/-/g, '')

async function mkAudio(u: { id: string; discordId: string }, uploadId: string | null, status: string, deleted = false): Promise<number> {
  const [r] = await ownerSql()`INSERT INTO event_audio (owner_user_id, owner_discord_id, upload_id, kind, title, status, deleted_at)
    VALUES (${u.id}, ${u.discordId}, ${uploadId}, 'song', 'T', ${status}, ${deleted ? new Date() : null}) RETURNING id`
  return Number(r!.id)
}

describe.skipIf(!DBENV())('events: uploads site + budgets (uploads/caps.ts)', () => {
  afterAll(async () => {
    await ownerSql()`UPDATE uploads SET status = 'expired' WHERE status IN ('uploading','complete','attached')`
    await closeDb()
  })

  it('stamps the site; music default unchanged', async () => {
    const u = await mkUser()
    const m = hex()
    const e = hex()
    expect(await admitUpload(db(), u.id, m, 1 * MB, DEFAULT_CAPS, 'mp3')).toBeNull()
    expect(await admitUpload(db(), u.id, e, 1 * MB, DEFAULT_CAPS, 'mp3', { site: 'events', eventsBudgetBytes: 100 * MB })).toBeNull()
    const rows = await ownerSql()`SELECT id, site FROM uploads WHERE id IN (${m}, ${e})`
    expect(Object.fromEntries(rows.map((r) => [r.id, r.site]))).toEqual({ [m]: 'music', [e]: 'events' })
    await ownerSql()`UPDATE uploads SET status = 'expired' WHERE owner_user_id = ${u.id}`
  })

  it('events uploads must fit the events budget; music uploads ignore it', async () => {
    const u = await mkUser()
    const used = await siteStagedBytes(db(), 'events')
    const budget = used + 10 * MB
    expect(await admitUpload(db(), u.id, hex(), 6 * MB, DEFAULT_CAPS, 'mp3', { site: 'events', eventsBudgetBytes: budget })).toBeNull()
    expect(await admitUpload(db(), u.id, hex(), 6 * MB, DEFAULT_CAPS, 'mp3', { site: 'events', eventsBudgetBytes: budget })).toMatchObject({ status: 503, code: 'staging_full' })
    expect(await admitUpload(db(), u.id, hex(), 6 * MB, DEFAULT_CAPS, 'mp3')).toBeNull()
    await ownerSql()`UPDATE uploads SET status = 'expired' WHERE owner_user_id = ${u.id}`
  })

  it('per-user in flight counts attached uploads whose event_audio is probing|ready|ingesting, not live', async () => {
    const u = await mkUser()
    const caps = { ...DEFAULT_CAPS, maxInflightBytesPerUser: 20 * MB }
    const up = hex()
    await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status, site) VALUES (${up}, ${u.id}, ${15 * MB}, 'attached', 'events')`
    const audio = await mkAudio(u, up, 'probing')
    expect(await admitUpload(db(), u.id, hex(), 6 * MB, caps)).toMatchObject({ status: 429, code: 'inflight_quota' })
    for (const s of ['ready', 'ingesting']) {
      await ownerSql()`UPDATE event_audio SET status = ${s} WHERE id = ${audio}`
      expect(await admitUpload(db(), u.id, hex(), 6 * MB, caps), s).toMatchObject({ code: 'inflight_quota' })
    }
    await ownerSql()`UPDATE event_audio SET status = 'live' WHERE id = ${audio}`
    expect(await admitUpload(db(), u.id, hex(), 6 * MB, caps)).toBeNull()
    await ownerSql()`UPDATE uploads SET status = 'expired' WHERE owner_user_id = ${u.id}`
  })
})

describe.skipIf(!DBENV())('events: per-site sweepers', () => {
  it('each site expires only its own uploads; events releases uploads its audio no longer needs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-sweep-'))
    const u = await mkUser()
    const mk = async (site: string, status: string, age: string) => {
      const id = hex()
      writeFileSync(join(dir, id), 'x')
      await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status, site, created_at) VALUES (${id}, ${u.id}, 1, ${status}::upload_status, ${site}, now() - ${age}::interval)`
      return id
    }
    const staleMusic = await mk('music', 'uploading', '25 hours')
    const staleEvents = await mk('events', 'uploading', '25 hours')
    const attLive = await mk('events', 'attached', '1 hour')
    const attDeleted = await mk('events', 'attached', '1 hour')
    const attReady = await mk('events', 'attached', '1 hour')
    await mkAudio(u, attLive, 'live')
    await mkAudio(u, attDeleted, 'ready', true)
    await mkAudio(u, attReady, 'ready')

    await sweepStaging(db(), dir, Date.now(), 'events')
    const st = async () => Object.fromEntries((await ownerSql()`SELECT id, status FROM uploads WHERE owner_user_id = ${u.id}`).map((r) => [r.id, r.status]))
    let s = await st()
    expect(s[staleEvents]).toBe('expired')
    expect(s[staleMusic]).toBe('uploading')
    expect(s[attLive]).toBe('expired')
    expect(s[attDeleted]).toBe('expired')
    expect(s[attReady]).toBe('attached')
    expect(existsSync(join(dir, attLive))).toBe(false)
    expect(existsSync(join(dir, attReady))).toBe(true)
    expect(existsSync(join(dir, staleMusic))).toBe(true)

    await sweepStaging(db(), dir, Date.now(), 'music')
    s = await st()
    expect(s[staleMusic]).toBe('expired')
    expect(s[attReady]).toBe('attached')
  })

  it('a music batch cannot attach an events upload (409, untouched); a music upload still attaches', async () => {
    const u = await mkUser()
    const v: Viewer = { userId: u.id, discordId: u.discordId, name: null, perms: new Set(['submit']) as Viewer['perms'] }
    const spool = mkdtempSync(join(tmpdir(), 'ev-attach-'))
    const ev = hex()
    const mu = hex()
    await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status, site) VALUES (${ev}, ${u.id}, ${50 * MB}, 'complete', 'events'), (${mu}, ${u.id}, ${1 * MB}, 'complete', 'music')`
    const b = await createBatch(db(), v)
    const eventsBefore = await siteStagedBytes(db(), 'events')
    await expect(addUploadToBatch(db(), v, b.id, ev, spool)).rejects.toMatchObject({ status: 409, code: 'upload_not_available' })
    const [row] = await ownerSql()`SELECT status, site FROM uploads WHERE id = ${ev}`
    expect(row).toMatchObject({ status: 'complete', site: 'events' })
    expect((await ownerSql()`SELECT count(*)::int AS n FROM items WHERE batch_id = ${b.id}`)[0]!.n).toBe(0)
    expect(await siteStagedBytes(db(), 'events')).toBe(eventsBefore)
    await expect(addUploadToBatch(db(), v, b.id, mu, spool)).resolves.toMatchObject({ status: 'probing' })
    await ownerSql()`UPDATE uploads SET status = 'expired' WHERE owner_user_id = ${u.id}`
  })

  it('the events sweep expires and unlinks an events upload attached to anything but an event_audio row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-sweep-foreign-'))
    const u = await mkUser()
    const foreign = hex()
    const own = hex()
    const musicAttached = hex()
    for (const id of [foreign, own, musicAttached]) writeFileSync(join(dir, id), 'x')
    // foreign: an events upload a music batch attached before the site check
    await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status, site) VALUES
      (${foreign}, ${u.id}, ${50 * MB}, 'attached', 'events'), (${own}, ${u.id}, ${1 * MB}, 'attached', 'events'), (${musicAttached}, ${u.id}, ${1 * MB}, 'attached', 'music')`
    await mkAudio(u, own, 'probing')
    const before = await siteStagedBytes(db(), 'events')
    await sweepStaging(db(), dir, Date.now(), 'events')
    const st = Object.fromEntries((await ownerSql()`SELECT id, status FROM uploads WHERE owner_user_id = ${u.id}`).map((r) => [r.id, r.status]))
    expect(st[foreign]).toBe('expired')
    expect(st[own]).toBe('attached')
    expect(st[musicAttached]).toBe('attached')
    expect(existsSync(join(dir, foreign))).toBe(false)
    expect(existsSync(join(dir, own))).toBe(true)
    expect(existsSync(join(dir, musicAttached))).toBe(true)
    expect(await siteStagedBytes(db(), 'events')).toBe(before - 50 * MB)
    await ownerSql()`UPDATE uploads SET status = 'expired' WHERE owner_user_id = ${u.id}`
  })

  it('the art sweep only touches this site\'s rows', async () => {
    const u = await mkUser()
    const spoolIn = mkdtempSync(join(tmpdir(), 'ev-art-'))
    const id = randomUUID()
    await ownerSql()`INSERT INTO art_uploads (id, owner, status, created_at) VALUES (${id}, ${u.id}, 'processing', now() - interval '25 hours')`
    await sweepArt(db(), { spoolIn }, Date.now(), 'events')
    expect((await ownerSql()`SELECT status FROM art_uploads WHERE id = ${id}`)[0]!.status).toBe('processing')
    await sweepArt(db(), { spoolIn }, Date.now(), 'music')
    expect((await ownerSql()`SELECT status FROM art_uploads WHERE id = ${id}`)[0]!.status).toBe('rejected')
  })
})

describe.skipIf(!DBENV())('events: library sync foreign set', () => {
  it('reads every registered event playlist id', async () => {
    const u = await mkUser()
    const [ev] = await ownerSql()`INSERT INTO events (owner_user_id, owner_discord_id, title, event_type, starts_at, ends_at, entered_tz, visibility, status)
      VALUES (${u.id}, ${u.discordId}, 'T', 'other', now() + interval '2 days', now() + interval '2 days 2 hours', 'UTC', 'public', 'approved') RETURNING id`
    const [b] = await ownerSql()`INSERT INTO event_builds (event_id, version, plan) VALUES (${ev!.id}, 1, '{}'::jsonb) RETURNING id`
    const pid = 90_000 + Math.floor(Math.random() * 9_000)
    await ownerSql()`INSERT INTO event_registry (event_id, build_id, role, intent_name, playlist_id) VALUES (${ev!.id}, ${b!.id}, 'main', 'T', ${pid}), (${ev!.id}, ${b!.id}, 'pin', '~EVT1 s1', NULL)`
    const ids = await eventRegistryPlaylistIds(db())
    expect(ids).toContain(pid)
    expect(ids.every((n) => Number.isSafeInteger(n) && n > 0)).toBe(true)
  })
})

describe.skipIf(!DBENV())('events: create-attempt marker (worker store, orphan adoption proof)', () => {
  it('round-trips the latest marker per intent row, as the app role; none for another row', async () => {
    const u = await mkUser()
    const [ev] = await ownerSql()`INSERT INTO events (owner_user_id, owner_discord_id, title, event_type, starts_at, ends_at, entered_tz, visibility, status)
      VALUES (${u.id}, ${u.discordId}, 'T', 'other', now() + interval '2 days', now() + interval '2 days 2 hours', 'UTC', 'public', 'approved') RETURNING id`
    const store = new PgEventsStore(db())
    const b = await store.createBuild(Number(ev!.id), 1, {})
    const row = await store.insertIntent(Number(ev!.id), b.id, 'main', 'T')
    const other = await store.insertIntent(Number(ev!.id), b.id, 'pin', `~EVT${ev!.id} s1`)
    expect(await store.createAttempt(row.id)).toBeNull()
    await store.markCreateAttempt(row.id, { eventId: Number(ev!.id), buildId: b.id, name: 'T', maxIdBefore: 140 })
    await store.markCreateAttempt(row.id, { eventId: Number(ev!.id), buildId: b.id, name: 'T', maxIdBefore: 155 })
    expect(await store.createAttempt(row.id)).toEqual({ eventId: Number(ev!.id), buildId: b.id, name: 'T', maxIdBefore: 155 })
    expect(await store.createAttempt(other.id)).toBeNull()
  })
})

describe.skipIf(!DBENV())('events: settings module (manage only)', () => {
  const viewer = (perms: string[]): Viewer => ({ userId: randomUUID(), discordId: '123456789012345678', name: null, perms: new Set(perms) as Viewer['perms'] })

  it('manage reads and patches; others are refused; the change is audited', async () => {
    await expect(getEventsSettings(db(), viewer(['submit', 'review']))).rejects.toMatchObject({ status: 403 })
    await expect(putEventsSettings(db(), viewer(['review']), { events_enabled: true })).rejects.toMatchObject({ status: 403 })
    const m = viewer(['submit', 'review', 'manage'])
    await expect(putEventsSettings(db(), m, { events_bogus: 1 })).rejects.toMatchObject({ status: 400 })
    await expect(putEventsSettings(db(), m, { events_warn_notice_h: 1 })).rejects.toMatchObject({ status: 400, code: 'warn_below_min_notice' })
    const after = await putEventsSettings(db(), m, { events_gap_min: 15, events_pin_strategy: 'split_main' })
    expect(after.events_gap_min).toBe(15)
    expect((await loadEventsSettings(db())).events_pin_strategy).toBe('split_main')
    const [a] = await ownerSql()`SELECT detail FROM audit_log WHERE action = 'events.settings.update' ORDER BY id DESC LIMIT 1`
    expect(a!.detail).toMatchObject({ events_gap_min: { after: 15 } })
    await ownerSql()`DELETE FROM settings WHERE key IN ('events_gap_min', 'events_pin_strategy')`
  })
})

describe.skipIf(!DBENV())('events: locked Discord token refresh (auth/membership.ts)', () => {
  const guild = '915830850694815765'

  async function setup(accessExpiresInS: number) {
    const u = await mkUser()
    const pid = u.discordId
    const acct = encryptAccountTokens({ userId: u.id, type: 'oauth', provider: 'discord', providerAccountId: pid, access_token: 'A0', refresh_token: 'R0', expires_at: Math.floor(Date.now() / 1000) + accessExpiresInS })
    await ownerSql()`INSERT INTO account ("userId", type, provider, "providerAccountId", access_token, refresh_token, expires_at)
      VALUES (${u.id}, 'oauth', 'discord', ${pid}, ${acct.access_token}, ${acct.refresh_token}, ${acct.expires_at})`
    await ownerSql()`INSERT INTO session ("sessionToken", "userId", expires) VALUES (${randomUUID()}, ${u.id}, now() + interval '1 day')`
    return u
  }

  function deps(fetchImpl: typeof fetch): MembershipDeps {
    return { db: db(), apiBase: 'https://discord.test/api', tokenUrl: 'https://discord.test/token', guildId: guild, clientId: 'c', clientSecret: 's', ticketsApiBase: 'http://tickets.test', ticketsKey: '', fetchImpl }
  }

  const member = (id: string) => new Response(JSON.stringify({ roles: [], pending: false, user: { id } }), { status: 200, headers: { 'content-type': 'application/json' } })

  it('two concurrent refreshes (two webs): one token call, the other re-reads; nobody is revoked', async () => {
    const u = await setup(-10)
    let refreshes = 0
    let current = 'R0'
    const f = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/token')) {
        const rt = new URLSearchParams(String(init?.body)).get('refresh_token')
        await new Promise((r) => setTimeout(r, 150))
        if (rt !== current) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        refreshes++
        current = `R${refreshes}`
        return new Response(JSON.stringify({ access_token: `A${refreshes}`, refresh_token: current, expires_in: 3600 }), { status: 200 })
      }
      return member(u.discordId)
    }) as typeof fetch
    // Different levels bypass the in-process single-flight, like two processes.
    const [a, b] = await Promise.all([ensureFreshMembership(deps(f), { id: u.id, discordId: u.discordId }, 'member'), ensureFreshMembership(deps(f), { id: u.id, discordId: u.discordId }, 'elevated')])
    expect(a.member && b.member).toBe(true)
    expect(refreshes).toBe(1)
    expect((await loadDiscordTokens(db(), u.id))?.refreshToken).toBe('R1')
    expect((await ownerSql()`SELECT count(*)::int AS n FROM session WHERE "userId" = ${u.id}`)[0]!.n).toBe(1)
  })

  it('invalid_grant: re-reads once and uses tokens stored meanwhile instead of revoking', async () => {
    const u = await setup(-10)
    const f = (async (url: string | URL) => {
      if (String(url).endsWith('/token')) {
        // A sign-in stored new tokens (without the lock) while this refresh ran.
        const acct = encryptAccountTokens({ provider: 'discord', providerAccountId: u.discordId, access_token: 'A9', refresh_token: 'R9' })
        await ownerSql()`UPDATE account SET access_token = ${acct.access_token}, refresh_token = ${acct.refresh_token}, expires_at = ${Math.floor(Date.now() / 1000) + 3600} WHERE "userId" = ${u.id}`
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }
      return member(u.discordId)
    }) as typeof fetch
    const r = await ensureFreshMembership(deps(f), { id: u.id, discordId: u.discordId }, 'elevated')
    expect(r.member).toBe(true)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM session WHERE "userId" = ${u.id}`)[0]!.n).toBe(1)
  })

  it('a refresh that fails with nothing newer stored still revokes (unchanged)', async () => {
    const u = await setup(-10)
    const f = (async (url: string | URL) =>
      String(url).endsWith('/token') ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) : member(u.discordId)) as typeof fetch
    await expect(ensureFreshMembership(deps(f), { id: u.id, discordId: u.discordId }, 'elevated')).rejects.toMatchObject({ status: 401 })
    expect((await ownerSql()`SELECT count(*)::int AS n FROM session WHERE "userId" = ${u.id}`)[0]!.n).toBe(0)
  })
})
