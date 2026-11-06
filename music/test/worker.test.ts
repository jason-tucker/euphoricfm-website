import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { TicketsApiError, TicketsClient } from '@/server/tickets/client'
import { runJob, startupChecks } from '@/worker/main'
import { ticketComment, type WorkerCtx } from '@/worker/handlers'
import { closeDb, getDb } from '@/server/db/client'
import { MOCKS, DBENV } from './helpers/env'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepStaging } from '@/server/uploads/retention'
import { control } from './helpers/http'
import { ownerSql } from './helpers/db'

const ORIGIN = 'https://music.euphoric.fm'
const OPENER = '700000000000000001'

function recordingTickets() {
  const calls: string[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`)
    return new Response(JSON.stringify({ messageId: 'm', discordMessageId: '1', created: true }), { status: 201 })
  }) as unknown as typeof fetch
  return { calls, client: new TicketsClient({ baseUrl: 'http://tickets.invalid', key: 'k', portalOrigin: ORIGIN, fetchImpl: f }) }
}

describe('tickets client: local refusals', () => {
  it('never forwards a staff comment', async () => {
    const { calls, client } = recordingTickets()
    await expect(client.postComment(5, { id: 1, visibility: 'staff', body: 'secret' })).rejects.toMatchObject({ code: 'staff_comment_never_forwarded' })
    expect(calls).toHaveLength(0)
  })

  it('validates the open contract before sending (link origin, lengths, unknown keys)', async () => {
    const { calls, client } = recordingTickets()
    const good = { categoryKey: 'newsong', openerDiscordId: OPENER, subject: 's', card: { title: 't', lines: ['a'], link: { label: 'Open', url: `${ORIGIN}/batches/1` } }, externalRef: 'batch:1' }
    await expect(client.openTicket({ ...good, card: { ...good.card, link: { label: 'Open', url: 'https://evil.example/x' } } })).rejects.toThrow()
    await expect(client.openTicket({ ...good, subject: '   ' })).rejects.toThrow()
    await expect(client.openTicket({ ...good, card: { ...good.card, lines: Array(26).fill('x') } })).rejects.toThrow()
    await expect(client.openTicket({ ...good, externalRef: 'has space' })).rejects.toThrow()
    await expect(client.openTicket({ ...good, extra: 1 } as never)).rejects.toThrow()
    await expect(client.postMessage(1, { kind: 'comment', body: 'x' }, 'bad key!')).rejects.toMatchObject({ code: 'bad_idempotency_key' })
    await expect(client.postMessage(1, { kind: 'comment', body: 'x'.repeat(1801) }, 'k1')).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('classifies retryable errors', () => {
    expect(new TicketsApiError(409, 'opening_in_progress', 5).retryable).toBe(true)
    expect(new TicketsApiError(502, 'discord_unavailable', 30).retryable).toBe(true)
    expect(new TicketsApiError(409, 'ticket_closed').retryable).toBe(false)
    expect(new TicketsApiError(404, 'opener_not_member').retryable).toBe(false)
  })
})

describe.skipIf(!MOCKS())('tickets client against the Integration API mock', () => {
  const client = () => new TicketsClient({ baseUrl: process.env.MOCKS_TICKETS!, key: process.env.TICKETS_WRITE_KEY!, portalOrigin: ORIGIN })
  const open = (ref: string) =>
    client().openTicket({ categoryKey: 'newsong', openerDiscordId: OPENER, subject: 'Music submission', card: { title: 't', lines: ['l'], link: { label: 'Open in portal', url: `${ORIGIN}/batches/1` } }, externalRef: ref })

  it('open is idempotent per externalRef; errors map to codes', async () => {
    await control('/__mock/tickets/member', { id: OPENER, member: true })
    const ref = `batch:${Date.now()}`
    const a = await open(ref)
    const b = await open(ref)
    expect(a.created).toBe(true)
    expect(b).toMatchObject({ ticketId: a.ticketId, created: false })
    await control('/__mock/tickets/member', { id: '700000000000000002', member: false })
    await expect(
      client().openTicket({ categoryKey: 'newsong', openerDiscordId: '700000000000000002', subject: 's', card: { title: 't', lines: [], link: { label: 'x', url: `${ORIGIN}/` } }, externalRef: 'batch:x1' }),
    ).rejects.toMatchObject({ status: 404, code: 'opener_not_member' })
    await control('/__mock/tickets/fail-next', { status: 409, error: 'opening_in_progress', retryAfter: 5 })
    await expect(open(`batch:${Date.now()}b`)).rejects.toMatchObject({ code: 'opening_in_progress', retryAfterS: 5, retryable: true })
  })

  it('messages carry the Idempotency-Key and replay safely; PATCH and close', async () => {
    const t = await open(`batch:${Date.now()}m`)
    const m1 = await client().postMessage(t.ticketId, { kind: 'system', body: 'Approved: x', itemRef: 'item:1' }, 'decision:item:1:approved')
    const m2 = await client().postMessage(t.ticketId, { kind: 'system', body: 'Approved: x', itemRef: 'item:1' }, 'decision:item:1:approved')
    expect(m1.created).toBe(true)
    expect(m2).toMatchObject({ messageId: m1.messageId, created: false })
    const calls = (await control('/__mock/tickets/calls')) as { path: string; headers: Record<string, string> }[]
    const msgCalls = calls.filter((c) => c.path.endsWith('/messages'))
    expect(msgCalls.at(-1)!.headers['idempotency-key']).toBe('decision:item:1:approved')
    expect(msgCalls.at(-1)!.headers.authorization).toBe('[redacted]')
    await client().patchTicket(t.ticketId, { status: 'completed' })
    await client().closeTicket(t.ticketId)
    await expect(client().closeTicket(t.ticketId)).resolves.toMatchObject({ alreadyClosed: true })
    await expect(client().postMessage(t.ticketId, { kind: 'system', body: 'late' }, 'late-1')).rejects.toMatchObject({ code: 'ticket_closed' })
  })

  it('the web guild:read key cannot open tickets', async () => {
    const web = new TicketsClient({ baseUrl: process.env.MOCKS_TICKETS!, key: 'test-tickets-web-key', portalOrigin: ORIGIN })
    await expect(
      web.openTicket({ categoryKey: 'newsong', openerDiscordId: OPENER, subject: 's', card: { title: 't', lines: [], link: { label: 'x', url: `${ORIGIN}/` } }, externalRef: 'batch:web' }),
    ).rejects.toMatchObject({ status: 403, code: 'scope_missing' })
  })
})

describe.skipIf(!MOCKS())('worker start-up checks', () => {
  const base = {
    DATABASE_URL: 'postgres://unused',
    MUSIC_PROFILE: 'prod',
    STATION_ID: '1',
    PORTAL_TEST_PREFIX: 'Portal-Test/',
    AZURACAST_BASE_URL: process.env.MOCKS_AZURACAST,
    AZURACAST_API_KEY: process.env.AZURACAST_API_KEY,
    TICKETS_WRITE_KEY: 'x',
    ALLOW_TEST_ENDPOINTS: '1',
  }
  it('passes with a station-scoped key', async () => {
    await control('/__mock/az/mode', { superadmin: false })
    await expect(startupChecks({ env: base })).resolves.toMatchObject({ profile: { profile: 'prod', stationId: 1, testPrefix: 'Portal-Test/' } })
  })
  it('refuses: missing profile, wrong station, test without prefix, a key that reaches the canary station', async () => {
    await expect(startupChecks({ env: { ...base, MUSIC_PROFILE: undefined } })).rejects.toThrow(/MUSIC_PROFILE/)
    await expect(startupChecks({ env: { ...base, STATION_ID: '7' } })).rejects.toThrow(/STATION_ID=1/)
    await expect(startupChecks({ env: { ...base, MUSIC_PROFILE: 'test', PORTAL_TEST_PREFIX: undefined } })).rejects.toThrow(/PORTAL_TEST_PREFIX/)
    await control('/__mock/az/mode', { superadmin: true })
    await expect(startupChecks({ env: base })).rejects.toMatchObject({ code: 'self_check_canary_not_403' })
    await control('/__mock/az/mode', { superadmin: false })
    await expect(startupChecks({ env: { ...base, AZURACAST_API_KEY: 'wrong-key-000000000' } })).rejects.toMatchObject({ code: 'self_check_own_station' })
  })
})

describe.skipIf(!DBENV())('worker job: staff comments are dropped even if a job exists', () => {
  afterAll(async () => closeDb())
  it('ticketComment on a staff row makes no tickets call', async () => {
    const db = getDb(process.env.TEST_APP_DATABASE_URL, 2)
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${'8' + String(Date.now()).padStart(17, '0')}) RETURNING id`
    const [b] = await ownerSql()`INSERT INTO batches (owner_user_id, ticket_id) VALUES (${u!.id}, ${900000 + Math.floor(Math.random() * 99999)}) RETURNING id`
    const [c] = await ownerSql()`INSERT INTO comments (batch_id, source, visibility, body) VALUES (${b!.id}, 'portal', 'staff', 'never leaves') RETURNING id`
    const { calls, client } = recordingTickets()
    const ctx = { db, tickets: client } as unknown as WorkerCtx
    await ticketComment(ctx, { commentId: c!.id as number })
    expect(calls).toHaveLength(0)
  })
})

describe.skipIf(!DBENV())('staging retention sweep', () => {
  it('expires unfinished uploads after 24 h and unattached ones after 7 days, keeps fresh ones', async () => {
    const db = getDb(process.env.TEST_APP_DATABASE_URL, 2)
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'))
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${'7' + String(Date.now()).padStart(17, '0')}) RETURNING id`
    const mk = async (age: string, status: string) => {
      const id = randomUUID().replace(/-/g, '')
      writeFileSync(join(dir, id), 'x')
      writeFileSync(join(dir, `${id}.json`), '{}')
      await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status, created_at) VALUES (${id}, ${u!.id}, 1, ${status}::upload_status, now() - ${age}::interval)`
      return id
    }
    const staleTus = await mk('25 hours', 'uploading')
    const freshTus = await mk('1 hour', 'uploading')
    const staleDraft = await mk('8 days', 'complete')
    const freshDraft = await mk('2 days', 'complete')
    await sweepStaging(db, dir)
    expect(existsSync(join(dir, staleTus))).toBe(false)
    expect(existsSync(join(dir, `${staleTus}.json`))).toBe(false)
    expect(existsSync(join(dir, staleDraft))).toBe(false)
    expect(existsSync(join(dir, freshTus))).toBe(true)
    expect(existsSync(join(dir, freshDraft))).toBe(true)
    const st = await ownerSql()`SELECT id, status FROM uploads WHERE id IN (${staleTus}, ${freshTus}, ${staleDraft}, ${freshDraft})`
    const by = Object.fromEntries(st.map((r) => [r.id, r.status]))
    expect(by[staleTus]).toBe('expired')
    expect(by[staleDraft]).toBe('expired')
    expect(by[freshTus]).toBe('uploading')
  })
})

describe.skipIf(!DBENV())('draft retention (plan §3.4 "drafts after 7 days")', () => {
  it('expires items of a never-submitted draft after 7 days: files deleted, upload expired, audited; fresh drafts and submitted batches untouched', async () => {
    const db = getDb(process.env.TEST_APP_DATABASE_URL, 2)
    const dir = mkdtempSync(join(tmpdir(), 'sweep-draft-'))
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${'6' + String(Date.now()).padStart(17, '0')}) RETURNING id`
    const mkItem = async (batchId: number, age: string, status: string) => {
      const up = randomUUID().replace(/-/g, '')
      const cover = `cover-${randomUUID()}.jpg`
      writeFileSync(join(dir, up), 'x')
      writeFileSync(join(dir, `${up}.json`), '{}')
      writeFileSync(join(dir, cover), 'j')
      await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status, created_at) VALUES (${up}, ${u!.id}, 100, 'attached', now() - ${age}::interval)`
      const [it] = await ownerSql()`INSERT INTO items (batch_id, owner_user_id, status, upload_id, cover_file, created_at)
        VALUES (${batchId}, ${u!.id}, ${status}::item_status, ${up}, ${cover}, now() - ${age}::interval) RETURNING id`
      return { id: it!.id as number, up, cover }
    }
    const [oldDraft] = await ownerSql()`INSERT INTO batches (owner_user_id, status, created_at) VALUES (${u!.id}, 'draft', now() - interval '9 days') RETURNING id`
    const [freshDraft] = await ownerSql()`INSERT INTO batches (owner_user_id, status) VALUES (${u!.id}, 'draft') RETURNING id`
    const [submitted] = await ownerSql()`INSERT INTO batches (owner_user_id, status, attested_at, submitted_at, created_at) VALUES (${u!.id}, 'submitted', now(), now(), now() - interval '9 days') RETURNING id`
    const pendingOld = await mkItem(oldDraft!.id, '8 days', 'pending')
    const probingOld = await mkItem(oldDraft!.id, '8 days', 'probing')
    const fresh = await mkItem(freshDraft!.id, '1 day', 'pending')
    const inReview = await mkItem(submitted!.id, '8 days', 'pending')

    const staged = async () => Number((await ownerSql()`SELECT COALESCE(SUM(length),0)::bigint AS n FROM uploads WHERE owner_user_id = ${u!.id} AND status IN ('uploading','complete','attached')`)[0]!.n)
    expect(await staged()).toBe(400)
    await sweepStaging(db, dir)
    for (const x of [pendingOld, probingOld]) {
      expect(existsSync(join(dir, x.up))).toBe(false)
      expect(existsSync(join(dir, `${x.up}.json`))).toBe(false)
      expect(existsSync(join(dir, x.cover))).toBe(false)
      const [row] = await ownerSql()`SELECT status, probe_error, upload_id FROM items WHERE id = ${x.id}`
      expect(row).toMatchObject({ status: 'withdrawn', probe_error: 'draft_expired', upload_id: null })
      expect((await ownerSql()`SELECT status FROM uploads WHERE id = ${x.up}`)[0]!.status).toBe('expired')
      expect((await ownerSql()`SELECT count(*)::int AS n FROM audit_log WHERE action = 'item.draft_expired' AND target_id = ${String(x.id)}`)[0]!.n).toBe(1)
    }
    for (const x of [fresh, inReview]) {
      expect(existsSync(join(dir, x.up))).toBe(true)
      expect((await ownerSql()`SELECT status FROM items WHERE id = ${x.id}`)[0]!.status).toBe('pending')
    }
    expect((await ownerSql()`SELECT status FROM batches WHERE id = ${oldDraft!.id}`)[0]!.status).toBe('withdrawn')
    expect((await ownerSql()`SELECT status FROM batches WHERE id = ${freshDraft!.id}`)[0]!.status).toBe('draft')
    expect(await staged()).toBe(200) // no longer counts toward the staging caps
  })

  // v0.4.1 security review of the link cancel (A3): the reserve is released
  // at the cancel, so what the probe publishes afterwards must not stay.
  it('a SoundCloud link withdrawn while probing: whatever the probe publishes later is removed at every sweep; other withdrawn items keep 7 days', async () => {
    const db = getDb(process.env.TEST_APP_DATABASE_URL, 2)
    const dir = mkdtempSync(join(tmpdir(), 'sweep-sc-'))
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${'4' + String(Date.now()).padStart(17, '0')}) RETURNING id`
    const [b] = await ownerSql()`INSERT INTO batches (owner_user_id, status) VALUES (${u!.id}, 'draft') RETURNING id`
    const mk = async (probeSha: string | null) => {
      const up = randomUUID().replace(/-/g, '')
      const fetchId = randomUUID()
      await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status) VALUES (${up}, ${u!.id}, ${60 * 1024 * 1024}, 'expired')`
      const [it] = await ownerSql()`INSERT INTO items (batch_id, owner_user_id, status, source, upload_id, fetch_request_id, probe_request_id, probe_sha256)
        VALUES (${b!.id}, ${u!.id}, 'withdrawn', 'soundcloud', ${up}, ${fetchId}, ${fetchId}, ${probeSha}) RETURNING id`
      return { id: it!.id as number, up, cover: `cover-${fetchId}.jpg` }
    }
    const cancelled = await mk(null) // withdrawn while converting: never collected
    const afterReady = await mk('e'.repeat(64)) // withdrawn once pending: the normal 7 days
    const publish = (x: { up: string; cover: string }) => {
      writeFileSync(join(dir, x.up), 'mp3')
      writeFileSync(join(dir, x.cover), 'jpg')
    }
    publish(cancelled)
    publish(afterReady)
    await sweepStaging(db, dir)
    expect(existsSync(join(dir, cancelled.up))).toBe(false)
    expect(existsSync(join(dir, cancelled.cover))).toBe(false)
    expect(existsSync(join(dir, afterReady.up))).toBe(true)
    expect(existsSync(join(dir, afterReady.cover))).toBe(true)
    // a late publication (the probe was still converting at the first sweep) goes at the next
    publish(cancelled)
    await sweepStaging(db, dir)
    expect(existsSync(join(dir, cancelled.up))).toBe(false)
    expect(existsSync(join(dir, cancelled.cover))).toBe(false)
    expect((await ownerSql()`SELECT upload_id FROM items WHERE id = ${cancelled.id}`)[0]!.upload_id).toBe(cancelled.up)
  })
})

describe.skipIf(!DBENV())('dependency waits do not spend attempts (ticket not open yet)', () => {
  it('a ticket_comment waiting for its ticket survives many retries, and dies (with an alert) only past its max age', async () => {
    const db = getDb(process.env.TEST_APP_DATABASE_URL, 2)
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${'5' + String(Date.now()).padStart(17, '0')}) RETURNING id`
    const [b] = await ownerSql()`INSERT INTO batches (owner_user_id, status, attested_at, submitted_at) VALUES (${u!.id}, 'submitted', now(), now()) RETURNING id`
    const [c] = await ownerSql()`INSERT INTO comments (batch_id, source, visibility, body) VALUES (${b!.id}, 'portal', 'all', 'waits for the ticket') RETURNING id`
    // run_after in the future so the live worker leaves it alone; we drive runJob directly
    const [j] = await ownerSql()`INSERT INTO jobs (kind, payload, run_after, dedupe_key) VALUES ('ticket_comment', ${ownerSql().json({ commentId: c!.id })}, now() + interval '1 hour', ${`t-wait-${c!.id}`}) RETURNING id`
    const alerts: string[] = []
    const { client } = recordingTickets()
    const ctx = { db, tickets: client, alert: async (t: string) => void alerts.push(t) } as unknown as WorkerCtx
    for (let i = 0; i < 12; i++) {
      const [row] = await ownerSql()`UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ${j!.id} RETURNING attempts, max_attempts`
      await runJob(ctx, { id: Number(j!.id), kind: 'ticket_comment', payload: { commentId: c!.id }, attempts: row!.attempts, max_attempts: row!.max_attempts, age_s: 600 })
    }
    let [st] = await ownerSql()`SELECT status, attempts FROM jobs WHERE id = ${j!.id}`
    expect(st).toMatchObject({ status: 'queued', attempts: 0 })
    expect(alerts).toEqual([])
    await runJob(ctx, { id: Number(j!.id), kind: 'ticket_comment', payload: { commentId: c!.id }, attempts: 1, max_attempts: 8, age_s: 8 * 24 * 3600 })
    ;[st] = await ownerSql()`SELECT status FROM jobs WHERE id = ${j!.id}`
    expect(st!.status).toBe('dead')
    expect(alerts[0]).toMatch(/gave up after waiting/)
  })

  it('transient tickets errors get a 24 h budget, not 8 quick tries', async () => {
    const db = getDb(process.env.TEST_APP_DATABASE_URL, 2)
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${'5' + String(Date.now() + 1).padStart(17, '0')}) RETURNING id`
    const [b] = await ownerSql()`INSERT INTO batches (owner_user_id, status, ticket_id) VALUES (${u!.id}, 'submitted', ${800000 + Math.floor(Math.random() * 99999)}) RETURNING id`
    const [c] = await ownerSql()`INSERT INTO comments (batch_id, source, visibility, body) VALUES (${b!.id}, 'portal', 'all', 'bot is down') RETURNING id`
    const [j] = await ownerSql()`INSERT INTO jobs (kind, payload, run_after, dedupe_key) VALUES ('ticket_comment', ${ownerSql().json({ commentId: c!.id })}, now() + interval '1 hour', ${`t-502-${c!.id}`}) RETURNING id`
    const f = (async () => new Response(JSON.stringify({ error: 'bot_unavailable' }), { status: 502 })) as unknown as typeof fetch
    const alerts: string[] = []
    const ctx = { db, tickets: new TicketsClient({ baseUrl: 'http://t.invalid', key: 'k', portalOrigin: ORIGIN, fetchImpl: f }), alert: async (t: string) => void alerts.push(t) } as unknown as WorkerCtx
    for (let i = 0; i < 10; i++) await runJob(ctx, { id: Number(j!.id), kind: 'ticket_comment', payload: { commentId: c!.id }, attempts: 8, max_attempts: 8, age_s: 3600 })
    expect((await ownerSql()`SELECT status FROM jobs WHERE id = ${j!.id}`)[0]!.status).toBe('queued')
    await runJob(ctx, { id: Number(j!.id), kind: 'ticket_comment', payload: { commentId: c!.id }, attempts: 8, max_attempts: 8, age_s: 25 * 3600 })
    expect((await ownerSql()`SELECT status FROM jobs WHERE id = ${j!.id}`)[0]!.status).toBe('dead')
  })
})

describe.skipIf(!DBENV() || !MOCKS())('comment actor: staff/opener rule and the 403 fallback (v0.12.2)', () => {
  const STAFF_ROLE = '1144462744456794153'
  it('opener and staff post as themselves; a bound role outside the category staff falls back once, named, and is never lost', async () => {
    const db = getDb(process.env.TEST_APP_DATABASE_URL, 2)
    const tickets = new TicketsClient({ baseUrl: process.env.MOCKS_TICKETS!, key: process.env.TICKETS_WRITE_KEY!, portalOrigin: ORIGIN })
    const t0 = Date.now()
    const opener = `31${String(t0).padStart(16, '0')}`
    const staff = `32${String(t0).padStart(16, '0')}`
    const outsider = `33${String(t0).padStart(16, '0')}`
    const ownerOnly = `34${String(t0).padStart(16, '0')}`
    const extraRole = `35${String(t0).padStart(16, '0')}`
    await control('/__mock/tickets/member', { id: opener, member: true })
    await control('/__mock/tickets/member', { id: staff, member: true, roleIds: [STAFF_ROLE] })
    await control('/__mock/tickets/member', { id: outsider, member: true, roleIds: [extraRole] })
    await control('/__mock/tickets/member', { id: ownerOnly, member: true, roleIds: [] })
    const t = await tickets.openTicket({ categoryKey: 'newsong', openerDiscordId: opener, subject: 's', card: { title: 't', lines: [], link: { label: 'Open', url: `${ORIGIN}/b` } }, externalRef: `batch:actor${t0}` })
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id, name) VALUES (${randomUUID()}, ${opener}, 'Opener') RETURNING id`
    const [b] = await ownerSql()`INSERT INTO batches (owner_user_id, status, ticket_id) VALUES (${u!.id}, 'submitted', ${t.ticketId}) RETURNING id`
    // An admin-added 'review' binding for a role the tickets category does not list as staff.
    await ownerSql()`INSERT INTO role_bindings (role_id, permission, note, created_by) VALUES (${extraRole}, 'review', 'test', 'test')`
    for (const [id, roles] of [[staff, [STAFF_ROLE]], [outsider, [extraRole]], [ownerOnly, []]] as const) {
      await ownerSql()`INSERT INTO member_cache (discord_id, member, pending, role_ids, source, checked_at) VALUES (${id}, true, false, ${roles as unknown as string[]}, 'discord', now())
                       ON CONFLICT (discord_id) DO UPDATE SET role_ids = EXCLUDED.role_ids`
    }
    try {
      const alerts: string[] = []
      const ctx = { db, tickets, alert: async (x: string) => void alerts.push(x) } as unknown as WorkerCtx
      const post = async (author: string, name: string, body: string) => {
        const [c] = await ownerSql()`INSERT INTO comments (batch_id, source, visibility, body, author_discord_id, author_name) VALUES (${b!.id}, 'portal', 'all', ${body}, ${author}, ${name}) RETURNING id`
        await ticketComment(ctx, { commentId: c!.id as number })
        return c!.id as number
      }
      const cOpener = await post(opener, 'Opener', `from opener ${t0}`)
      const cStaff = await post(staff, 'Staffer', `from staff ${t0}`)
      const cOutsider = await post(outsider, 'New *Reviewer* @everyone', `from outsider ${t0}`)
      const cOwner = await post(ownerOnly, 'Owner Admin', `from owner ${t0}`)
      const msgs = (await control('/__mock/tickets/messages')) as { key: string; body: string; actorDiscordId: string | null }[]
      const mine = msgs.filter((m) => m.key.startsWith(`${t.ticketId}|`))
      expect(mine.find((m) => m.key.endsWith(`comment:${cOpener}`))).toMatchObject({ actorDiscordId: opener, body: `from opener ${t0}` })
      expect(mine.find((m) => m.key.endsWith(`comment:${cStaff}`))).toMatchObject({ actorDiscordId: staff })
      // refused as actor (403 actor_forbidden) → posted once without it, named
      expect(mine.find((m) => m.key.endsWith(`comment:${cOutsider}`))).toBeUndefined()
      expect(mine.find((m) => m.key.endsWith(`comment:${cOutsider}:anon`))).toMatchObject({ actorDiscordId: null, body: `New Reviewer everyone: from outsider ${t0}` })
      // no staff role at all: never sent as actor in the first place
      expect(mine.find((m) => m.key.endsWith(`comment:${cOwner}:anon`))).toMatchObject({ actorDiscordId: null, body: `Owner Admin: from owner ${t0}` })
      const calls = (await control('/__mock/tickets/calls')) as { path: string; body?: { body?: string; actorDiscordId?: string } }[]
      expect(calls.filter((x) => x.body?.body?.includes(`from owner ${t0}`) && x.body.actorDiscordId)).toHaveLength(0)
      const ids = await ownerSql()`SELECT id, ticket_message_id FROM comments WHERE id IN (${cOpener}, ${cStaff}, ${cOutsider}, ${cOwner})`
      expect(ids.every((r) => r.ticket_message_id)).toBe(true)
      expect((await ownerSql()`SELECT count(*)::int AS n FROM audit_log WHERE action = 'comment.actor_fallback' AND target_id = ${String(cOutsider)}`)[0]!.n).toBe(1)
      expect(alerts).toEqual([])
    } finally {
      await ownerSql()`DELETE FROM role_bindings WHERE role_id = ${extraRole}`
    }
  })
})

describe.skipIf(!DBENV())('album-art retention', () => {
  it('expires unreferenced art after 7 days (raw deleted, probe asked to release the JPEG), keeps referenced art, times out stuck processing', async () => {
    const { sweepArt } = await import('@/server/art/retention')
    const db = getDb(process.env.TEST_APP_DATABASE_URL, 2)
    const spoolIn = mkdtempSync(join(tmpdir(), 'art-spool-'))
    const artIn = mkdtempSync(join(tmpdir(), 'art-in-'))
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${'4' + String(Date.now()).padStart(17, '0')}) RETURNING id`
    const mk = async (status: string, age: string) => {
      const id = randomUUID()
      writeFileSync(join(artIn, id), 'raw')
      await ownerSql()`INSERT INTO art_uploads (id, owner, status, raw_path, jpeg_path, jpeg_sha256, created_at)
        VALUES (${id}, ${u!.id}, ${status}::art_status, ${join(artIn, id)}, ${`/staging/art/${id}/cover.jpg`}, ${'a'.repeat(64)}, now() - ${age}::interval)`
      return id
    }
    const oldReady = await mk('ready', '8 days')
    const oldRejected = await mk('rejected', '8 days')
    const freshReady = await mk('ready', '2 days')
    const referenced = await mk('ready', '8 days')
    const stuck = await mk('processing', '25 hours')
    await ownerSql()`INSERT INTO requests (owner_user_id, kind, media_id, target_path, proposed, status)
      VALUES (${u!.id}, 'edit', 1, 'Music/Artists/A/x.mp3', ${ownerSql().json({ artId: referenced })}, 'pending')`
    await sweepArt(db, { spoolIn })
    const st = Object.fromEntries((await ownerSql()`SELECT id::text AS id, status::text AS status, reason FROM art_uploads WHERE owner = ${u!.id}`).map((r) => [r.id, r]))
    expect(st[oldReady]!.status).toBe('expired')
    expect(st[oldRejected]!.status).toBe('expired')
    expect(st[freshReady]!.status).toBe('ready')
    expect(st[referenced]!.status).toBe('ready')
    expect(st[stuck]).toMatchObject({ status: 'rejected', reason: 'probe_timeout' })
    expect(existsSync(join(artIn, oldReady))).toBe(false)
    expect(existsSync(join(artIn, stuck))).toBe(false)
    expect(existsSync(join(artIn, freshReady))).toBe(true)
    const { readdirSync, readFileSync } = await import('node:fs')
    const reqs = readdirSync(spoolIn).map((f) => JSON.parse(readFileSync(join(spoolIn, f), 'utf8')))
    const mine = reqs.filter((r) => [oldReady, oldRejected, freshReady, referenced, stuck].includes(r.artId))
    expect(mine).toEqual([expect.objectContaining({ type: 'art_release', artId: oldReady })]) // only READY art has a JPEG to release
    expect((await ownerSql()`SELECT count(*)::int AS n FROM audit_log WHERE action = 'art.expired' AND target_id IN (${oldReady}, ${oldRejected})`)[0]!.n).toBe(2)
  })
})
