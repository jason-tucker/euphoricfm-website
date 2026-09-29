import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeSpoolResultNoClobber } from '@/server/spool/protocol'
import { probeRequestIdForUpload } from '@/events/contract/paths'
import { finalizeRequestIdFor } from '@/events/worker/jobs/audio'
import { endWaitTarget } from '@/events/worker/jobs/kicks'
import { eventsAlerter } from '@/events/worker/main'
import { EVENTS_MUTATING_KINDS, runEventJob, tickPeriodic } from '@/events/worker/loop'
import { harness, OWNER, settingsWith, type Harness } from './events-fakes'

let dirs: { spoolIn: string; spoolOut: string; final: string }
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'efm-events-'))
  dirs = { spoolIn: mkdtempSync(join(root, 'in-')), spoolOut: mkdtempSync(join(root, 'out-')), final: mkdtempSync(join(root, 'final-')) }
})

const T = (iso: string) => new Date(iso).getTime()

async function drain(h: Harness, max = 200): Promise<number> {
  let n = 0
  for (; n < max; n++) {
    const job = await h.store.claimJob(EVENTS_MUTATING_KINDS)
    if (!job) break
    await runEventJob(h.ctx, job)
  }
  return n
}

async function runOne(h: Harness, kind: string) {
  const j = h.store.jobs.find((x) => x.kind === kind && x.status === 'queued')
  if (!j) throw new Error(`no queued ${kind}`)
  j.runAfter = 0
  const claimed = (await h.store.claimJob(EVENTS_MUTATING_KINDS))!
  expect(claimed.kind).toBe(kind)
  await runEventJob(h.ctx, claimed)
  return h.store.jobs.find((x) => x.id === claimed.id)!
}

// A built-ready world: event 42 (2026-10-10 20:00–22:00 ET) with two
// library songs; 501 also sits in legacy 74 and station-1 playlist 5.
function world(start = '2026-10-01T12:03:00Z') {
  const h = harness(start, dirs)
  h.store.settingRows = settingsWith({})
  const s1 = h.az.addFile('Music/Artists/A/a.mp3', { id: 501, playlists: [74, 5] })
  const s2 = h.az.addFile('Music/Artists/B/b.mp3', { id: 502 })
  h.az.addFile('Music/Artists/C/c.mp3', { id: 503 })
  h.az.addFile('EFM Stingers/welcome.mp3', { id: 601, length: 30 })
  h.store.stingers = [{ mediaId: 601, path: 'EFM Stingers/welcome.mp3', title: 'Welcome', lengthS: 30 }]
  h.store.addEvent({ id: 42 })
  h.store.trackRows.set(42, [
    { position: 1, source: 'library', mediaId: 501, audioId: null, pinAt: null },
    { position: 2, source: 'library', mediaId: 502, audioId: null, pinAt: null },
  ])
  return { h, s1, s2 }
}

const mainIdOf = (h: Harness, eventId: number) => h.store.reg.find((r) => r.eventId === eventId && r.role === 'main' && !r.deletedAt)!.playlistId!

describe('events worker: tickets', () => {
  it('opens in eventrequest with event:<id> and the events link; posts wait for the ticket, then go with an Idempotency-Key', async () => {
    const { h } = world()
    h.store.events[0]!.status = 'pending'
    await h.store.enqueue('ticket_post', { eventId: 42, kind: 'submitted', body: 'Submitted for review', idem: 'submitted:42:1' })
    await h.store.enqueue('ticket_open', { eventId: 42 })
    await drain(h)
    const open = h.tickets.calls.find((c) => c.url.endsWith('/api/v1/tickets'))!
    expect(open.body).toMatchObject({ categoryKey: 'eventrequest', openerDiscordId: OWNER, subject: 'Event request #42', externalRef: 'event:42', card: { link: { url: 'https://events.euphoric.fm/my/events/42' } } })
    expect(h.store.events[0]!.ticketId).toBe(500)
    // the post waited (a ticket_open job existed), then was woken
    h.clock.t += 61_000
    await drain(h)
    const post = h.tickets.calls.find((c) => c.url.endsWith('/messages'))!
    expect(post.url).toContain('/api/v1/tickets/500/messages')
    expect(post.idem).toBe('evt:submitted:42:1')
    expect(post.body).toMatchObject({ kind: 'system', body: 'Submitted for review' })
    await h.store.enqueue('ticket_close', { eventId: 42, reason: 'Withdrawn by the member' })
    await drain(h)
    expect(h.tickets.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { status: 'closed' } })
  })

  it('a staff booking without a ticket: posts are dropped, not retried forever', async () => {
    const { h } = world()
    await h.store.enqueue('ticket_post', { eventId: 42, kind: 'approved', body: 'x', idem: 'approved:42:1' })
    await drain(h)
    expect(h.tickets.calls).toHaveLength(0)
    expect(h.store.job('ticket_post')[0]!.status).toBe('done')
  })
})

describe('events worker: build', () => {
  it('build respects events_autobuild_enabled; build_now bypasses it', async () => {
    const { h } = world()
    await h.store.enqueue('build', { eventId: 42, version: 1 })
    await drain(h)
    expect(h.az.writes()).toHaveLength(0)
    expect(h.store.audits.some((a) => a.action === 'events.build.skipped')).toBe(true)
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    expect(h.store.events[0]!.status).toBe('built')
  })

  it('autobuild on: intent row before every create, created disabled, membership merged, enabled, kicks scheduled', async () => {
    const { h, s1, s2 } = world()
    h.store.settingRows = settingsWith({ events_autobuild_enabled: true })
    const intents: boolean[] = []
    h.az.onCreate = (name) => intents.push(h.store.reg.some((r) => r.intentName === name && r.playlistId === null))
    await h.store.enqueue('build', { eventId: 42, version: 1 })
    await drain(h)
    expect(intents).toEqual([true])
    const create = h.az.writes().find((w) => w.method === 'POST')!
    expect(create.body).toMatchObject({ name: 'Grand Opening', is_enabled: false, source: 'songs', include_in_on_demand: false, include_in_requests: false })
    const main = mainIdOf(h, 42)
    expect(main).toBeGreaterThan(80)
    expect(h.az.playlists.get(main)!.is_enabled).toBe(true)
    expect(s1.playlists.sort((a, b) => a - b)).toEqual([5, 74, main])
    expect(s2.playlists).toEqual([main])
    expect(h.store.events[0]!.status).toBe('built')
    expect(h.store.maxLockDepth).toBe(1)
    const start = h.store.job('start_kick')[0]!
    expect(start.runAfter).toBe(T('2026-10-10T20:00:05-04:00'))
    expect(start.maxAttempts).toBe(2)
    expect(h.store.job('end_kick')[0]!.runAfter).toBe(T('2026-10-10T22:00:00-04:00'))
    expect(h.store.job('recheck')[0]!.runAfter).toBe(T('2026-10-10T19:00:00-04:00'))
    // verify ran and asked to post 'built'
    expect(h.store.job('verify')[0]!.status).toBe('done')
    expect(h.store.job('ticket_post', (p) => p.kind === 'built')).toHaveLength(1)
    // no legacy playlist was ever written
    expect(h.az.writes().some((w) => /\/playlist\/(7[4-8]|[1-7]?\d)(\/|$)/.test(w.path))).toBe(false)
  })

  it('shared song across two events + legacy 74 + station-1 id; teardown of one leaves the other intact', async () => {
    const { h, s1 } = world()
    h.store.addEvent({ id: 43, title: 'Car Meet', startsAt: new Date('2026-10-11T20:00:00-04:00'), endsAt: new Date('2026-10-11T22:00:00-04:00') })
    h.store.trackRows.set(43, [
      { position: 1, source: 'library', mediaId: 501, audioId: null, pinAt: null },
      { position: 2, source: 'library', mediaId: 503, audioId: null, pinAt: null },
    ])
    await h.store.enqueue('build_now', { eventId: 42 })
    await h.store.enqueue('build_now', { eventId: 43 })
    await drain(h)
    const a = mainIdOf(h, 42)
    const b = mainIdOf(h, 43)
    expect(s1.playlists.sort((x, y) => x - y)).toEqual([5, 74, a, b].sort((x, y) => x - y))
    h.store.events.find((e) => e.id === 43)!.status = 'cancelled'
    await h.store.enqueue('teardown', { eventId: 43 }, { dedupeExtra: 'cancelled' })
    await drain(h)
    expect(h.az.playlists.has(b)).toBe(false)
    expect(s1.playlists.sort((x, y) => x - y)).toEqual([5, 74, a])
    expect(h.store.reg.filter((r) => r.eventId === 43).every((r) => r.deletedAt)).toBe(true)
    expect(h.store.reg.filter((r) => r.eventId === 42).every((r) => !r.deletedAt)).toBe(true)
  })

  it('rebuild: same main playlist, a dropped song loses only this event’s id, a new pin playlist appears', async () => {
    const { h, s2 } = world()
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    const main = mainIdOf(h, 42)
    s2.playlists.push(74)
    const ev = h.store.events[0]!
    ev.version = 2
    h.store.trackRows.set(42, [
      { position: 1, source: 'library', mediaId: 501, audioId: null, pinAt: null },
      { position: 2, source: 'library', mediaId: 503, audioId: null, pinAt: new Date('2026-10-10T21:00:00-04:00') },
    ])
    await h.store.enqueue('build_now', { eventId: 42 }, { dedupeExtra: 'v2' })
    await drain(h)
    expect(mainIdOf(h, 42)).toBe(main)
    expect(s2.playlists).toEqual([74])
    const pin = h.store.reg.find((r) => r.eventId === 42 && r.role === 'pin')!
    expect(pin.intentName).toBe('~EVT42 s1')
    expect(h.az.files.get(503)!.playlists).toEqual([pin.playlistId])
    expect(h.az.playlists.get(pin.playlistId!)!.backend_options).toEqual(['single_track'])
    expect(h.store.buildRows.find((b) => b.version === 2)!.status).toBe('applied')
  })

  it('an orphan from a crash between create and record is adopted, never duplicated', async () => {
    const { h } = world()
    const ev = h.store.events[0]!
    const b = await h.store.createBuild(42, 1, {})
    const row = await h.store.insertIntent(42, b.id, 'main', 'Grand Opening')
    // the crashed attempt: marker committed (highest id then: 149), POST
    // made playlist 150, the worker died before recording it
    await h.store.markCreateAttempt(row.id, { eventId: 42, buildId: b.id, name: 'Grand Opening', maxIdBefore: 149 })
    h.az.playlists.set(150, { ...h.az.playlists.get(76)!, id: 150, name: 'Grand Opening', is_enabled: false })
    await h.store.enqueue('build_now', { eventId: ev.id })
    await drain(h)
    expect(mainIdOf(h, 42)).toBe(150)
    expect(h.az.writes().some((w) => w.method === 'POST' && w.path.endsWith('/playlists'))).toBe(false)
    expect(h.alerts.some((a) => a.includes('adopted orphan playlist 150'))).toBe(true)
    expect(h.store.events[0]!.status).toBe('built')
  })

  it('a create crash is healed end to end: the retried build adopts what the first attempt created', async () => {
    const { h } = world()
    // the first attempt's POST succeeds, then the worker "dies" before the id is recorded
    const record = h.store.setRegistryPlaylist.bind(h.store)
    let died = false
    h.store.setRegistryPlaylist = async (...a) => {
      if (!died) {
        died = true
        throw new Error('worker died')
      }
      return record(...a)
    }
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    const made = [...h.az.playlists.values()].filter((p) => p.name === 'Grand Opening')
    expect(made).toHaveLength(1)
    expect(h.store.reg.find((r) => r.intentName === 'Grand Opening')!.playlistId).toBeNull()
    // the retry (same build id) adopts it; no second create
    h.clock.t += 3600_000
    await drain(h)
    expect(mainIdOf(h, 42)).toBe(made[0]!.id)
    expect([...h.az.playlists.values()].filter((p) => p.name === 'Grand Opening')).toHaveLength(1)
    expect(h.store.events[0]!.status).toBe('built')
  })

  it('first build of an event titled like an existing disabled station playlist fails and alerts; it never adopts it', async () => {
    const { h } = world()
    // a staff playlist kept for later, same name as the member's event title
    h.az.playlists.set(150, { ...h.az.playlists.get(76)!, id: 150, name: 'Grand Opening', is_enabled: false })
    h.az.addFile('Music/Artists/D/d.mp3', { id: 504, playlists: [150] })
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    expect(h.store.buildRows[0]!.status).toBe('failed')
    expect(h.store.buildRows[0]!.lastError).toBe('playlist_name_collision')
    expect(h.alerts.some((a) => a.includes('playlist_name_collision'))).toBe(true)
    expect(h.alerts.some((a) => a.includes('adopted'))).toBe(false)
    expect(h.store.events[0]!.status).toBe('approved')
    // playlist 150 untouched: no write to it, still holds its file, nothing registered
    expect(h.az.writes().some((w) => /\/playlist\/150(\/|$)/.test(w.path))).toBe(false)
    expect(h.az.writes().some((w) => w.method === 'POST' && w.path.endsWith('/playlists'))).toBe(false)
    expect(h.az.files.get(504)!.playlists).toEqual([150])
    expect(h.store.reg.some((r) => r.playlistId === 150)).toBe(false)
    // a cancel + teardown never deletes it either
    h.store.events[0]!.status = 'cancelled'
    await h.store.enqueue('teardown', { eventId: 42 }, { dedupeExtra: 'cancelled' })
    await drain(h)
    expect(h.az.playlists.has(150)).toBe(true)
  })

  it('an intent row left WITHOUT a create-attempt marker (crash before the POST) never adopts a same-named playlist', async () => {
    const { h } = world()
    const b = await h.store.createBuild(42, 1, {})
    await h.store.insertIntent(42, b.id, 'main', 'Grand Opening')
    h.az.playlists.set(150, { ...h.az.playlists.get(76)!, id: 150, name: 'Grand Opening', is_enabled: false })
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    expect(h.store.buildRows[0]!.lastError).toBe('playlist_name_collision')
    expect(h.store.reg.some((r) => r.playlistId === 150)).toBe(false)
  })

  it('a marker only proves playlists created after it: an older same-named playlist is a collision', async () => {
    const { h } = world()
    const b = await h.store.createBuild(42, 1, {})
    const row = await h.store.insertIntent(42, b.id, 'main', 'Grand Opening')
    h.az.playlists.set(150, { ...h.az.playlists.get(76)!, id: 150, name: 'Grand Opening', is_enabled: false })
    await h.store.markCreateAttempt(row.id, { eventId: 42, buildId: b.id, name: 'Grand Opening', maxIdBefore: 150 })
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    expect(h.store.buildRows[0]!.lastError).toBe('playlist_name_collision')
    expect(h.store.reg.some((r) => r.playlistId === 150)).toBe(false)
  })

  it('custom audio of another member fails the build; a compile error fails it with a ticket note', async () => {
    const { h } = world()
    h.store.addAudio({ id: 7, ownerUserId: 'user-2', ownerDiscordId: '700000000000000002', status: 'live', mediaId: 700, kind: 'song' })
    h.store.trackRows.set(42, [...(await h.store.tracks(42)), { position: 3, source: 'upload', mediaId: null, audioId: 7, pinAt: null }])
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    expect(h.az.writes()).toHaveLength(0)
    expect(h.alerts.some((a) => a.includes('audio_not_owned'))).toBe(true)
    const { h: h2 } = world()
    h2.store.trackRows.set(42, [{ position: 1, source: 'library', mediaId: 501, audioId: null, pinAt: new Date('2026-10-10T21:55:00-04:00') }, { position: 2, source: 'library', mediaId: 502, audioId: null, pinAt: null }])
    await h2.store.enqueue('build_now', { eventId: 42 })
    await drain(h2)
    expect(h2.store.buildRows[0]!.status).toBe('failed')
    expect(h2.store.buildRows[0]!.lastError).toBe('pin_too_late')
    expect(h2.store.job('ticket_post', (p) => p.kind === 'failed')).toHaveLength(1)
  })

  it('verify: a tampered playlist fails the build', async () => {
    const { h } = world()
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    const build = h.store.buildRows[0]!
    h.az.playlists.get(mainIdOf(h, 42))!.include_in_on_demand = true
    await h.store.enqueue('verify', { eventId: 42, buildId: build.id }, { dedupeKey: 'verify:again' })
    await drain(h)
    expect(build.status).toBe('failed')
    expect(build.lastError).toContain('include_in_on_demand')
  })
})

describe('events worker: kicks and teardown', () => {
  async function built(start?: string) {
    const w = world(start)
    await w.h.store.enqueue('build_now', { eventId: 42 })
    await drain(w.h)
    return w
  }

  it('start kick: waits for start + 5 s, purges, restarts once, goes live', async () => {
    const { h } = await built()
    h.az.queue = [9]
    h.clock.t = T('2026-10-10T20:00:00-04:00')
    await runOne(h, 'start_kick')
    expect(h.az.restarts).toBe(0)
    h.clock.t = T('2026-10-10T20:00:05-04:00')
    await drain(h)
    expect(h.az.restarts).toBe(1)
    expect(h.az.queue).toEqual([])
    expect(h.store.events[0]!.status).toBe('live')
    expect(h.store.job('ticket_post', (p) => p.kind === 'on_air')).toHaveLength(1)
  })

  it('start kick: retries once after 30 s, then fails the build, tells the ticket and alerts (never loops)', async () => {
    const { h } = await built()
    h.az.failRestarts = 5
    h.clock.t = T('2026-10-10T20:00:05-04:00')
    await drain(h)
    const kick = h.store.job('start_kick')[0]!
    expect(kick.status).toBe('queued')
    expect(kick.runAfter).toBe(h.clock.t + 30_000)
    h.clock.t += 30_000
    await drain(h)
    expect(kick.status).toBe('dead')
    const restartCalls = h.az.calls.filter((c) => c.path.endsWith('/backend/restart'))
    expect(restartCalls).toHaveLength(2)
    expect(h.store.buildRows.at(-1)!.status).toBe('failed')
    expect(h.store.job('ticket_post', (p) => p.kind === 'failed')).toHaveLength(1)
    expect(h.alerts.some((a) => a.includes('start kick FAILED'))).toBe(true)
    h.clock.t += 3600_000
    await drain(h)
    expect(h.az.calls.filter((c) => c.path.endsWith('/backend/restart'))).toHaveLength(2)
  })

  it('end kick: waits for the last song (≤ 90 s), then disables, purges, restarts; teardown 24 h later', async () => {
    const { h } = await built()
    h.clock.t = T('2026-10-10T20:00:05-04:00')
    await drain(h)
    const end = T('2026-10-10T22:00:00-04:00')
    h.clock.t = end
    h.az.np = { is_online: true, now_playing: { played_at: (end - 100_000) / 1000, duration: 160 } }
    await drain(h)
    expect(h.az.restarts).toBe(1)
    expect(h.store.job('end_kick')[0]!.runAfter).toBe(end + 62_000)
    h.clock.t = end + 62_000
    await drain(h)
    expect(h.az.restarts).toBe(2)
    expect(h.az.playlists.get(mainIdOf(h, 42))!.is_enabled).toBe(false)
    expect(h.store.events[0]!.status).toBe('ended')
    const td = h.store.job('teardown')[0]!
    expect(td.runAfter).toBe(end + 24 * 3600_000)
    h.clock.t = end + 24 * 3600_000
    await drain(h)
    expect(h.store.reg.every((r) => r.deletedAt)).toBe(true)
    expect(h.store.buildRows.every((b) => b.status === 'torn_down')).toBe(true)
  })

  it('end wait target: capped at the deadline, unknown now-playing waits for it, a song after the end means go', () => {
    const end = 1_000_000_000_000
    const dl = end + 90_000
    expect(endWaitTarget({ now_playing: { played_at: (end - 10_000) / 1000, duration: 600 } }, end, dl, end)).toBe(dl)
    expect(endWaitTarget(null, end, dl, end)).toBe(dl)
    expect(endWaitTarget({ now_playing: { played_at: (end + 5_000) / 1000, duration: 200 } }, end, dl, end + 6_000)).toBe(end + 6_000)
    expect(endWaitTarget({ is_online: false }, end, dl, end)).toBe(end)
    expect(endWaitTarget({ now_playing: { played_at: (end - 10_000) / 1000, duration: 20 } }, end, dl, end)).toBe(end + 12_000)
  })

  it('adjacent staff pair: the ending event only disables; the next start kick does the single purge + restart', async () => {
    const { h } = await built()
    h.store.addEvent({ id: 44, title: 'After Party', createdByStaff: true, startsAt: new Date('2026-10-10T22:00:00-04:00'), endsAt: new Date('2026-10-10T23:00:00-04:00') })
    h.store.trackRows.set(44, [{ position: 1, source: 'library', mediaId: 503, audioId: null, pinAt: null }])
    await h.store.enqueue('build_now', { eventId: 44 })
    await drain(h)
    h.clock.t = T('2026-10-10T20:00:05-04:00')
    await drain(h)
    expect(h.az.restarts).toBe(1)
    h.clock.t = T('2026-10-10T22:00:00-04:00')
    h.az.np = { is_online: true, now_playing: { played_at: (h.clock.t - 10_000) / 1000, duration: 200 } }
    await drain(h)
    expect(h.store.events.find((e) => e.id === 42)!.status).toBe('ended')
    expect(h.az.playlists.get(mainIdOf(h, 42))!.is_enabled).toBe(false)
    expect(h.az.restarts).toBe(1)
    h.clock.t = T('2026-10-10T22:00:05-04:00')
    await drain(h)
    expect(h.az.restarts).toBe(2)
    expect(h.store.events.find((e) => e.id === 44)!.status).toBe('live')
  })

  it('a rebuild before the start leaves two start kicks queued: only one restart', async () => {
    const { h } = await built()
    const ev = h.store.events[0]!
    ev.version = 2
    await h.store.enqueue('build_now', { eventId: 42 }, { dedupeExtra: 'v2' })
    await drain(h)
    expect(h.store.job('start_kick')).toHaveLength(2)
    h.clock.t = T('2026-10-10T20:00:05-04:00')
    await drain(h)
    expect(h.az.restarts).toBe(1)
    expect(h.store.job('start_kick').every((j) => j.status === 'done')).toBe(true)
  })

  it('a staff-confirmed schedule change while live restarts once to load the new rows', async () => {
    const { h } = await built()
    h.clock.t = T('2026-10-10T20:00:05-04:00')
    await drain(h)
    expect(h.az.restarts).toBe(1)
    h.clock.t = T('2026-10-10T20:30:00-04:00')
    const ev = h.store.events[0]!
    ev.version = 2
    ev.endsAt = new Date('2026-10-10T22:30:00-04:00')
    await h.store.enqueue('build_now', { eventId: 42 }, { dedupeExtra: 'v2' })
    await drain(h)
    expect(h.az.restarts).toBe(2)
    expect(h.az.playlists.get(mainIdOf(h, 42))!.schedule_items).toMatchObject([{ start_time: 2000, end_time: 2230 }])
  })

  it('a start kick never restarts into a stale build (event edited back to approved)', async () => {
    const { h } = await built()
    const ev = h.store.events[0]!
    ev.version = 2
    h.clock.t = T('2026-10-10T20:00:05-04:00')
    await drain(h)
    expect(h.az.restarts).toBe(0)
    expect(h.alerts.some((a) => a.includes('no applied build for version 2'))).toBe(true)
  })

  it('teardown of an event sent back for review only disables its playlists', async () => {
    const { h } = await built()
    h.store.events[0]!.status = 'pending'
    await h.store.enqueue('teardown', { eventId: 42 }, { dedupeExtra: 'edit' })
    await drain(h)
    expect(h.az.playlists.get(mainIdOf(h, 42))!.is_enabled).toBe(false)
    expect(h.store.reg.every((r) => !r.deletedAt)).toBe(true)
  })

  it('recheck (T−60): an archived song is dropped from this event only; the ticket is told', async () => {
    const { h, s2 } = await built()
    const main = mainIdOf(h, 42)
    s2.path = 'Removed/12/b.mp3'
    s2.playlists.push(74)
    h.clock.t = T('2026-10-10T19:00:00-04:00')
    await drain(h)
    expect(s2.playlists).toEqual([74])
    expect(h.az.files.get(501)!.playlists).toContain(main)
    expect(h.store.job('ticket_post', (p) => p.kind === 'recheck')).toHaveLength(1)
  })

  it('queues_paused holds every AzuraCast-writing kind; tickets still run', async () => {
    const { h } = world()
    h.store.paused = true
    h.store.events[0]!.status = 'pending'
    await h.store.enqueue('build_now', { eventId: 42 })
    await h.store.enqueue('ticket_open', { eventId: 42 })
    await drain(h)
    expect(h.store.job('build_now')[0]!.status).toBe('queued')
    expect(h.store.job('ticket_open')[0]!.status).toBe('done')
    expect(h.az.writes()).toHaveLength(0)
  })
})

describe('events worker: stale jobs do nothing (event moved on)', () => {
  const stale = (h: Harness, kind: string) => h.store.audits.filter((a) => a.action === 'events.job.stale' && a.detail.kind === kind)

  it('build: an older version or a non-buildable status is done with a note, no station write', async () => {
    const { h } = world()
    h.store.settingRows = settingsWith({ events_autobuild_enabled: true })
    h.store.events[0]!.version = 2
    await h.store.enqueue('build', { eventId: 42, version: 1 })
    h.store.events[0]!.status = 'approved'
    await drain(h)
    expect(h.store.job('build')[0]!.status).toBe('done')
    expect(stale(h, 'build')[0]!.detail).toMatchObject({ jobVersion: 1, version: 2 })
    h.store.events[0]!.status = 'pending'
    await h.store.enqueue('build', { eventId: 42, version: 2 })
    await drain(h)
    expect(stale(h, 'build')).toHaveLength(2)
    expect(h.az.writes()).toHaveLength(0)
    expect(h.store.buildRows).toHaveLength(0)
  })

  it('build_now on a withdrawn event: done with a note, not dead, no alert', async () => {
    const { h } = world()
    h.store.events[0]!.status = 'withdrawn'
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    expect(h.store.job('build_now')[0]!.status).toBe('done')
    expect(stale(h, 'build_now')).toHaveLength(1)
    expect(h.alerts).toEqual([])
    expect(h.az.writes()).toHaveLength(0)
  })

  it('an edit that lands DURING the build: the build is recorded, but the event is not marked built and no kicks are scheduled', async () => {
    const { h } = world()
    const ev = h.store.events[0]!
    h.az.onCreate = () => {
      ev.version = 2
      ev.status = 'pending'
    }
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    expect(ev.status).toBe('pending')
    expect(h.store.buildRows[0]!.status).toBe('applied')
    for (const k of ['start_kick', 'end_kick', 'recheck', 'verify']) expect(h.store.job(k), k).toHaveLength(0)
    expect(stale(h, 'build')[0]!.detail).toMatchObject({ buildVersion: 1, version: 2, status: 'pending' })
  })

  it('verify, recheck, start and end kicks of an event sent back to pending: done with a note, nothing written', async () => {
    const w = world()
    const h = w.h
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    const build = h.store.buildRows[0]!
    const ev = h.store.events[0]!
    // a member edit: back to pending at a new version (the web enqueues the teardown)
    ev.version = 2
    ev.status = 'pending'
    const writesBefore = h.az.writes().length
    await h.store.enqueue('verify', { eventId: 42, buildId: build.id }, { dedupeKey: 'verify:stale' })
    await drain(h)
    expect(stale(h, 'verify')[0]!.detail).toMatchObject({ buildId: build.id, buildVersion: 1 })
    expect(build.status).toBe('applied')
    h.clock.t = T('2026-10-10T19:00:00-04:00')
    await drain(h)
    expect(stale(h, 'recheck')).toHaveLength(1)
    h.clock.t = T('2026-10-10T22:05:00-04:00')
    await drain(h)
    expect(stale(h, 'start_kick')).toHaveLength(1)
    expect(stale(h, 'end_kick')).toHaveLength(1)
    for (const k of ['recheck', 'start_kick', 'end_kick']) expect(h.store.job(k)[0]!.status, k).toBe('done')
    expect(h.az.writes()).toHaveLength(writesBefore)
    expect(h.az.restarts).toBe(0)
    expect(h.store.job('ticket_post', (p) => p.kind === 'on_air' || p.kind === 'ended')).toHaveLength(0)
  })

  it('recheck of a built event whose version moved on without a rebuild: done with a note', async () => {
    const { h, s2 } = world()
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    h.store.events[0]!.version = 2
    s2.path = 'Removed/12/b.mp3'
    h.clock.t = T('2026-10-10T19:00:00-04:00')
    await runOne(h, 'recheck')
    expect(stale(h, 'recheck')[0]!.detail).toMatchObject({ buildVersion: 1, version: 2 })
    expect(h.store.job('ticket_post', (p) => p.kind === 'recheck')).toHaveLength(0)
  })

  it('an end kick is never dropped for a version bump alone (it is what takes the event off air)', async () => {
    const { h } = world()
    await h.store.enqueue('build_now', { eventId: 42 })
    await drain(h)
    h.clock.t = T('2026-10-10T20:00:05-04:00')
    await drain(h)
    expect(h.store.events[0]!.status).toBe('live')
    h.store.events[0]!.version = 2 // a live details edit with autobuild off: no rebuild
    h.clock.t = T('2026-10-10T22:01:30-04:00')
    await drain(h)
    expect(h.store.events[0]!.status).toBe('ended')
    expect(h.az.playlists.get(mainIdOf(h, 42))!.is_enabled).toBe(false)
  })
})

describe('events worker: custom audio', () => {
  const UPLOAD = 'ab'.repeat(16)

  async function probed(h: Harness, over: Record<string, unknown> = {}, durationS = 29.6) {
    h.store.addAudio({ id: 7, uploadId: UPLOAD, kind: 'announcement', title: 'Welcome to the show', ...over })
    await writeSpoolResultNoClobber(dirs.spoolOut, { v: 1, id: probeRequestIdForUpload(UPLOAD), source: 'in-web', type: 'probe', ok: true, sha256: 'a'.repeat(64), size: 1000, durationS, bitrate: 192000, tags: { title: null, artist: null, album: null, genre: null }, cover: null, flags: [] })
    await tickPeriodic(h.ctx, {})
  }

  function finalize(h: Harness, bytes = Buffer.from('ID3 final bytes')) {
    const a = h.store.audio.find((x) => x.id === 7)!
    const file = '11111111-1111-4111-8111-111111111111.mp3'
    writeFileSync(join(dirs.final, file), bytes)
    return writeSpoolResultNoClobber(dirs.spoolOut, { v: 1, id: finalizeRequestIdFor(a), source: 'in-worker', type: 'finalize', ok: true, file, finalSha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
  }

  it('collect → ready → finalize with server-set tags → ingest with pacing → verify after two scans → live', async () => {
    const h = harness('2026-10-01T12:03:00Z', dirs)
    h.store.settingRows = settingsWith({})
    await probed(h)
    const a = h.store.audio[0]!
    expect(a.status).toBe('ready')
    expect(a.durationS).toBe(30)
    await drain(h)
    expect(a.status).toBe('ingesting')
    const req = JSON.parse(readFileSync(join(dirs.spoolIn, readdirSync(dirs.spoolIn).find((f) => f.endsWith('.json'))!), 'utf8'))
    expect(req).toMatchObject({ type: 'finalize', upload: UPLOAD, approvedSha256: 'a'.repeat(64), tags: { title: 'Welcome to the show', artist: 'EuphoricFM Events', album: 'EuphoricFM Events', genre: '' }, cover: null })
    // finalize result not there yet: a wait
    expect(h.store.job('audio_ingest')[0]!.status).toBe('queued')
    await finalize(h)
    // the music worker uploaded 30 s ago: ≥ 90 s spacing
    h.store.musicLastUpload = h.clock.t - 30_000
    h.clock.t += 5_000
    await drain(h)
    expect(h.az.writes()).toHaveLength(0)
    expect(h.store.job('audio_ingest')[0]!.runAfter).toBe(h.store.musicLastUpload + 90_000)
    h.clock.t = h.store.musicLastUpload + 90_000
    await drain(h)
    const post = h.az.writes().find((w) => w.method === 'POST')!
    expect(post.path).toBe('/api/station/14/files')
    expect((post.body as { path: string }).path).toBe(`Events/Uploads/${OWNER}/evt-a7.mp3`)
    expect(h.az.writes().some((w) => w.method === 'PUT' && /\/file\/\d+$/.test(w.path))).toBe(true)
    expect(a.mediaId).not.toBeNull()
    expect(a.status).toBe('ingesting')
    expect(h.store.uploadAttempts).toHaveLength(1)
    h.clock.t += 11 * 60_000
    await drain(h)
    expect(a.status).toBe('live')
    expect(readdirSync(dirs.spoolIn).length).toBe(2) // finalize + cleanup_final
  })

  it('outside the scan window, or at the hourly cap, the upload waits', async () => {
    const h = harness('2026-10-01T12:01:10Z', dirs)
    h.store.settingRows = settingsWith({})
    await probed(h)
    await drain(h)
    await finalize(h)
    h.clock.t += 5_000
    await drain(h)
    expect(h.az.writes()).toHaveLength(0)
    const ingest = h.store.job('audio_ingest')[0]!
    expect(ingest.lastError).toContain('outside scan window')
    expect(ingest.runAfter).toBe(T('2026-10-01T12:01:30Z'))
    h.clock.t = T('2026-10-01T12:03:00Z')
    h.store.uploadAttempts = [h.clock.t - 50 * 60_000, h.clock.t - 40 * 60_000, h.clock.t - 30 * 60_000, h.clock.t - 20 * 60_000]
    ingest.runAfter = 0
    await drain(h)
    expect(h.az.writes()).toHaveLength(0)
    expect(ingest.lastError).toContain('events pacing')
    expect(ingest.runAfter).toBe(h.clock.t + 10 * 60_000)
  })

  it('a fresh upload that a folder playlist grabbed fails and blocks further ingest', async () => {
    const h = harness('2026-10-01T12:03:00Z', dirs)
    h.store.settingRows = settingsWith({})
    await probed(h)
    await drain(h)
    await finalize(h)
    h.clock.t += 5_000
    await drain(h)
    const a = h.store.audio[0]!
    h.az.files.get(a.mediaId!)!.playlists = [5]
    h.clock.t += 11 * 60_000
    await drain(h)
    expect(a.status).toBe('failed')
    expect(a.lastError).toBe('folder_playlist_attached')
    expect(h.ctx.ingestBlocked).toContain('playlist')
  })

  it('a song keeps the member tags unless they collide with a library song; empty tags are refused', async () => {
    const h = harness('2026-10-01T12:03:00Z', dirs)
    h.store.settingRows = settingsWith({})
    h.store.library = [{ artist: 'GRIM', title: 'Touch' }]
    await probed(h, { kind: 'song', title: 'Touch', artist: 'grim' }, 200)
    await drain(h)
    const req = JSON.parse(readFileSync(join(dirs.spoolIn, readdirSync(dirs.spoolIn)[0]!), 'utf8'))
    expect(req.tags).toMatchObject({ title: 'Touch (event version)', artist: 'grim' })
    const h2 = harness('2026-10-01T12:03:00Z', { ...dirs, spoolOut: mkdtempSync(join(tmpdir(), 'out2-')) })
    h2.store.settingRows = settingsWith({})
    dirs.spoolOut = h2.ctx.spoolOutDir
    await probed(h2, { kind: 'song', title: 'Untitled', artist: '  ' }, 200)
    await drain(h2)
    expect(h2.store.audio[0]!.status).toBe('failed')
    expect(h2.store.audio[0]!.lastError).toBe('empty_tags')
  })

  it('a 5 s announcement (the events probe accepts from 3 s) becomes ready', async () => {
    const h = harness('2026-10-01T12:03:00Z', dirs)
    h.store.settingRows = settingsWith({})
    await probed(h, {}, 5)
    expect(h.store.audio[0]!.status).toBe('ready')
    expect(h.store.audio[0]!.durationS).toBe(5)
  })

  it('a song under 30 s passes the (3 s) probe but is rejected too_short by audio_collect', async () => {
    const h2 = harness('2026-10-01T12:03:00Z', dirs)
    h2.store.settingRows = settingsWith({})
    await probed(h2, { kind: 'song', title: 'Short', artist: 'grim' }, 29.6)
    expect(h2.store.audio[0]).toMatchObject({ status: 'rejected', lastError: 'too_short', durationS: 30 })
    expect(h2.store.job('audio_finalize')).toHaveLength(0)
  })

  it('a rejected probe releases the staging bytes', async () => {
    const h = harness('2026-10-01T12:03:00Z', dirs)
    h.store.addAudio({ id: 8, uploadId: UPLOAD })
    await writeSpoolResultNoClobber(dirs.spoolOut, { v: 1, id: probeRequestIdForUpload(UPLOAD), source: 'in-web', type: 'probe', ok: false, error: 'too_long', released: true })
    await tickPeriodic(h.ctx, {})
    expect(h.store.audio[0]!.status).toBe('rejected')
    expect(h.store.expiredUploads).toEqual([UPLOAD])
  })

  it('audio_delete: waits while an active event uses it, then the narrow delete; never without deleted_at', async () => {
    const { h } = world()
    const f = h.az.addFile(`Events/Uploads/${OWNER}/evt-a7.mp3`)
    h.store.addAudio({ id: 7, status: 'live', mediaId: f.id, path: f.path, deletedAt: null })
    await h.store.enqueue('audio_delete', { audioId: 7 })
    await drain(h)
    expect(h.store.job('audio_delete')[0]!.status).toBe('dead')
    expect(h.az.files.has(f.id)).toBe(true)
    h.store.audio[0]!.deletedAt = new Date(h.clock.t)
    h.store.annRows.set(42, [{ id: 1, source: 'upload', mediaId: null, audioId: 7, mode: 'at', at: new Date('2026-10-10T20:30:00-04:00'), everyMin: null, fromAt: null, untilAt: null }])
    await h.store.enqueue('audio_delete', { audioId: 7 }, { dedupeKey: 'again' })
    await drain(h)
    expect(h.az.files.has(f.id)).toBe(true)
    h.store.events[0]!.status = 'ended'
    h.clock.t += 3601_000
    await drain(h)
    expect(h.az.files.has(f.id)).toBe(false)
  })
})

describe('events worker: sweeps', () => {
  it('pending_expire 12 h before start; one staff reminder; unused audio expiry', async () => {
    const h = harness('2026-10-10T09:00:00-04:00', dirs)
    h.store.settingRows = settingsWith({})
    h.store.addEvent({ id: 50, status: 'pending', ticketId: 9, startsAt: new Date('2026-10-10T20:00:00-04:00'), endsAt: new Date('2026-10-10T22:00:00-04:00') })
    h.store.addEvent({ id: 51, status: 'pending', ticketId: 10, submittedAt: new Date('2026-10-06T00:00:00Z'), startsAt: new Date('2026-11-10T20:00:00-05:00'), endsAt: new Date('2026-11-10T22:00:00-05:00') })
    h.store.addAudio({ id: 70, status: 'live', mediaId: 900, createdAt: new Date('2026-09-20T00:00:00Z') })
    h.store.addAudio({ id: 71, status: 'live', mediaId: 901, createdAt: new Date('2026-09-20T00:00:00Z'), usedAt: new Date('2026-09-21T00:00:00Z') })
    const state = {}
    await tickPeriodic(h.ctx, state)
    expect(h.store.events.find((e) => e.id === 50)!.status).toBe('expired')
    expect(h.store.job('ticket_close', (p) => p.eventId === 50)).toHaveLength(1)
    expect(h.store.job('teardown', (p) => p.eventId === 50)).toHaveLength(1)
    expect(h.store.job('ticket_post', (p) => p.kind === 'reminder' && p.eventId === 51)).toHaveLength(1)
    expect(h.store.audio.find((a) => a.id === 70)!.deletedAt).not.toBeNull()
    expect(h.store.audio.find((a) => a.id === 71)!.deletedAt).toBeNull()
    expect(h.store.job('audio_delete', (p) => p.audioId === 70)).toHaveLength(1)
    h.clock.t += 3600_000
    await tickPeriodic(h.ctx, {})
    expect(h.store.job('ticket_post', (p) => p.kind === 'reminder')).toHaveLength(1)
  })

  it('stinger sync caches EFM Stingers/ media only', async () => {
    const h = harness('2026-10-01T12:03:00Z', dirs)
    h.az.addFile('EFM Stingers/one.mp3', { id: 601, title: 'One', length: 12.4 })
    h.az.addFile('EFM Stingers/two.mp3', { id: 602, title: '', length: 8 })
    h.az.addFile('ADS/ad.mp3', { id: 603 })
    await tickPeriodic(h.ctx, {})
    expect(h.store.stingers).toEqual([
      { mediaId: 601, path: 'EFM Stingers/one.mp3', title: 'One', lengthS: 12 },
      { mediaId: 602, path: 'EFM Stingers/two.mp3', title: 'two', lengthS: 8 },
    ])
  })
})

describe('events worker: alerts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reuse the music makeAlert: the optional ALERT_DISCORD_WEBHOOK is paged (labelled Events), then an audit row', async () => {
    const posts: { url: string; body: { content: string; allowed_mentions: unknown } }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 204 })
    }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const audits: { action: string; detail: unknown }[] = []
    const store = { audit: async (action: string, _t: string, _id: number, detail?: Record<string, unknown>) => void audits.push({ action, detail }) }
    const on = await eventsAlerter(store, { ALERT_DISCORD_WEBHOOK: 'https://discord.example/api/webhooks/1/x' })
    await on('events start kick FAILED for event #42', { eventId: 42 })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe('https://discord.example/api/webhooks/1/x')
    expect(posts[0]!.body.content).toBe('⚠️ EFM Events Portal: events start kick FAILED for event #42')
    expect(posts[0]!.body.allowed_mentions).toEqual({ parse: [] })
    expect(audits).toEqual([{ action: 'events.alert', detail: { title: 'events start kick FAILED for event #42', detail: { eventId: 42 } } }])
    const off = await eventsAlerter(store, {})
    await off('another', {})
    expect(posts).toHaveLength(1)
    expect(audits).toHaveLength(2)
  })
})
