// P4 end to end through the real web and worker containers: filing edit and
// removal requests (one ticket each), the whitelist, caps, review races, the
// worker applying approved edits, the new-artist parking, manager library
// actions, and the admin settings / role-binding APIs.
import { beforeAll, describe, expect, it } from 'vitest'
import { E2E } from './helpers/env'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { control, Jar, req } from './helpers/http'
import { waitFor } from './helpers/wait'

const PREFIX = 'Portal-Test/'
const REVIEWER_ROLE = '1144462744456794153' // seeded review + manage
const ADMIN_ID = '117501528641634310' // PORTAL_OWNER_IDS in the test env
const RUN = Date.now().toString(36)
let seq = 0
const newId = () => `4${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`

type Media = { id: number; path: string; title: string; artist: string; genre: string | null; playlists: { id: number }[] }
type Ticket = { externalRef: string; categoryKey: string; opener: string; card: { title: string; lines: string[]; link: { url: string } } }
type Msg = { key: string; body: string; kind: string }

describe.skipIf(!E2E())('P4 requests and library management through the real containers', () => {
  let member: Jar
  let memberId: string
  let other: Jar
  let reviewer: Jar
  let admin: Jar
  const songs: Media[] = []
  const refused: number[] = []
  const folder = `E2E-${RUN}`
  const artistName = `E2E Artist ${RUN}`

  const files = async () => (await control('/__mock/az/files')) as Media[]
  const byId = async (id: number) => (await files()).find((f) => f.id === id)
  const tickets = async () => (await control('/__mock/tickets/tickets')) as Ticket[]
  const messages = async () => (await control('/__mock/tickets/messages')) as Msg[]
  const file = (jar: Jar, json: unknown) => req(jar, '/api/requests', { json })
  const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T

  beforeAll(async () => {
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('station_playlist_ids', '[2,3,5]'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    await ownerSql()`INSERT INTO artists (name, folder, status) VALUES (${artistName}, ${folder}, 'active')`
    const seedFiles = Array.from({ length: 16 }, (_, i) => ({
      path: `${PREFIX}Music/Artists/${folder}/song ${String(i).padStart(2, '0')}.mp3`,
      title: `Song ${String(i).padStart(2, '0')}`,
      artist: artistName,
      album: 'E2E Album',
      genre: 'Pop',
      playlists: [2],
    }))
    await control('/__mock/az/seed', { files: seedFiles })
    const all = await files()
    for (const f of seedFiles) songs.push(all.find((x) => x.path === f.path)!)
    for (const s of songs) {
      await ownerSql()`INSERT INTO library_cache (media_id, unique_id, path, title, artist, album, genre, playlist_ids)
        VALUES (${s.id}, ${'u' + s.id}, ${s.path}, ${s.title}, ${s.artist}, 'E2E Album', 'Pop', '{2}')`
    }
    const outside = [`${PREFIX}ADS/ad-${RUN}.mp3`, `${PREFIX}Events/Fri/ev-${RUN}.mp3`, `${PREFIX}UNRELEASED-${RUN}/u.mp3`, `${PREFIX}Removed/77/r-${RUN}.mp3`, `Music/Artists/Real/${RUN}.mp3`, `${PREFIX}root-${RUN}.mp3`, `${PREFIX}Music/Artists/${folder}/deep/${RUN}.mp3`]
    for (const [i, p] of outside.entries()) {
      const id = 880000 + (Number.parseInt(RUN.slice(-4), 36) % 9000) * 10 + i
      await ownerSql()`INSERT INTO library_cache (media_id, unique_id, path, title, artist) VALUES (${id}, ${'x' + id}, ${p}, 'Out', 'Side')`
      refused.push(id)
    }
    // songs[15] is archived: not requestable
    await ownerSql()`INSERT INTO archive (media_id, original_path, archived_path, status) VALUES (${songs[15]!.id}, ${songs[15]!.path}, ${`${PREFIX}Removed/${songs[15]!.id}/x.mp3`}, 'archived')`

    memberId = newId()
    member = await loginOk({ id: memberId })
    await control('/__mock/tickets/member', { id: memberId, member: true })
    other = await loginOk({ id: newId() })
    const reviewerId = newId()
    reviewer = await loginOk({ id: reviewerId, roles: [REVIEWER_ROLE] })
    await control('/__mock/tickets/member', { id: reviewerId, member: true })
    admin = await loginOk({ id: ADMIN_ID })
  })

  let editId: number
  let removalId: number

  it('a member files an edit: one ticket opens in songedit with current → proposed on the card', async () => {
    const r = await file(member, { kind: 'edit', mediaId: songs[0]!.id, proposed: { title: 'Fixed Title' }, reason: 'typo' })
    expect(r.status).toBe(201)
    editId = (await json<{ id: number }>(r)).id
    const t = await waitFor(async () => (await tickets()).find((x) => x.externalRef === `request:${editId}`))
    expect(t).toMatchObject({ categoryKey: 'songedit', opener: memberId })
    expect(t.card.lines).toContain('Title: "Song 00" → "Fixed Title"')
    expect(t.card.lines).toContain('Reason: typo')
    expect(new URL(t.card.link.url).pathname).toBe(`/requests/${editId}`)
    const mine = await json<{ id: number; status: string; ticket: unknown }[]>(await req(member, '/api/requests'))
    expect(mine.find((x) => x.id === editId)).toMatchObject({ status: 'pending' })
    const snap = (await ownerSql()`SELECT snapshot, proposed FROM requests WHERE id = ${editId}`)[0]!
    expect(snap.snapshot).toMatchObject({ path: songs[0]!.path, title: 'Song 00', artist: artistName, playlistIds: [2] })
    expect(snap.proposed).toEqual({ title: 'Fixed Title' })
    expect((await req(other, `/api/requests/${editId}`)).status).toBe(404)
    expect((await req(reviewer, `/api/requests/${editId}`)).status).toBe(200)
  })

  it('a removal needs a reason and opens its own songremoval ticket', async () => {
    expect((await file(member, { kind: 'removal', mediaId: songs[1]!.id })).status).toBe(400)
    expect((await file(member, { kind: 'removal', mediaId: songs[1]!.id, reason: '  ' })).status).toBe(400)
    const r = await file(member, { kind: 'removal', mediaId: songs[1]!.id, reason: 'Duplicate upload' })
    expect(r.status).toBe(201)
    removalId = (await json<{ id: number }>(r)).id
    const t = await waitFor(async () => (await tickets()).find((x) => x.externalRef === `request:${removalId}`))
    expect(t.categoryKey).toBe('songremoval')
    expect(t.card.lines).toContain('Reason: Duplicate upload')
  })

  it('refuses targets outside Music/Artists/<folder>/, archived songs and malformed proposals', async () => {
    for (const id of [...refused, songs[15]!.id, 2_000_000_000]) {
      expect((await file(member, { kind: 'removal', mediaId: id, reason: 'x' })).status, String(id)).toBe(404)
      expect((await file(member, { kind: 'edit', mediaId: id, proposed: { title: 'x' } })).status, String(id)).toBe(404)
    }
    const s = songs[2]!.id
    expect((await file(member, { kind: 'edit', mediaId: s, proposed: { path: 'Removed/1/x.mp3' } })).status).toBe(400)
    expect((await file(member, { kind: 'edit', mediaId: s, proposed: { title: 'Song 02' } })).status).toBe(400) // no change
    expect((await file(member, { kind: 'edit', mediaId: s, proposed: {} })).status).toBe(400)
    expect((await file(member, { kind: 'edit', azuracastMediaId: s, proposed: { title: 'y' } })).status).toBe(400)
    expect((await file(member, { kind: 'purge', mediaId: s })).status).toBe(400)
    expect((await req(member, '/api/requests', { json: { kind: 'removal', mediaId: s, reason: 'x' }, sameOrigin: false })).status).toBe(403) // CSRF
  })

  it('one open request per song and kind; withdraw is owner-only and pending-only', async () => {
    expect((await file(member, { kind: 'removal', mediaId: songs[1]!.id, reason: 'again' })).status).toBe(409)
    const r = await file(member, { kind: 'edit', mediaId: songs[3]!.id, proposed: { genre: 'House' } })
    const id = (await json<{ id: number }>(r)).id
    expect((await req(other, `/api/requests/${id}/withdraw`, { method: 'POST' })).status).toBe(404)
    expect((await req(member, `/api/requests/${id}/withdraw`, { method: 'POST' })).status).toBe(200)
    expect((await req(member, `/api/requests/${id}/withdraw`, { method: 'POST' })).status).toBe(409)
  })

  it('daily caps: 10 edits and 10 removals per member per day', async () => {
    const capId = newId()
    const jar = await loginOk({ id: capId })
    await control('/__mock/tickets/member', { id: capId, member: true })
    for (let i = 2; i <= 11; i++) expect((await file(jar, { kind: 'edit', mediaId: songs[i]!.id, proposed: { genre: `G${i}` } })).status).toBe(201)
    const over = await file(jar, { kind: 'edit', mediaId: songs[12]!.id, proposed: { genre: 'G12' } })
    expect(over.status).toBe(429)
    expect(await json(over)).toMatchObject({ error: 'daily_cap', limit: 10 })
    expect((await file(jar, { kind: 'removal', mediaId: songs[12]!.id, reason: 'separate cap' })).status).toBe(201)
  })

  it('approve race: exactly one reviewer wins; a deny needs a reason; members cannot decide', async () => {
    expect((await req(member, `/api/requests/${editId}/decision`, { json: { decision: 'approve' } })).status).toBe(403)
    expect((await req(reviewer, `/api/requests/${editId}/decision`, { json: { decision: 'deny' } })).status).toBe(400)
    const [a, b] = await Promise.all([
      req(reviewer, `/api/requests/${editId}/decision`, { json: { decision: 'approve' } }),
      req(reviewer, `/api/requests/${editId}/decision`, { json: { decision: 'approve' } }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect((await req(reviewer, `/api/requests/${editId}/decision`, { json: { decision: 'deny', reason: 'late' } })).status).toBe(409)
    // the worker applies it (no artist change → no move, no window needed)
    await waitFor(async () => (await byId(songs[0]!.id))?.title === 'Fixed Title')
    const row = await waitFor(async () => {
      const r = (await ownerSql()`SELECT status FROM requests WHERE id = ${editId}`)[0]!
      return r.status === 'verifying' ? r : null
    })
    expect(row.status).toBe('verifying')
    expect((await byId(songs[0]!.id))!.playlists.map((p) => p.id)).toEqual([2])
    const msgs = await waitFor(async () => {
      const m = (await messages()).filter((x) => x.key.includes(`request:${editId}:`))
      return m.length >= 2 ? m : null
    })
    expect(msgs.map((m) => m.body).join('\n')).toMatch(/Edit request approved[\s\S]*Edit applied/)
  })

  it('a deny posts the reason to the request’s own ticket', async () => {
    expect((await req(reviewer, `/api/requests/${removalId}/decision`, { json: { decision: 'deny', reason: 'Keep it in rotation' } })).status).toBe(200)
    await waitFor(async () => (await messages()).some((m) => m.key.endsWith(`request:${removalId}:denied`) && m.body.includes('Keep it in rotation')))
    expect((await ownerSql()`SELECT status, deny_reason FROM requests WHERE id = ${removalId}`)[0]).toMatchObject({ status: 'denied', deny_reason: 'Keep it in rotation' })
  })

  it('an edit to an unknown artist parks on a new-artist approval, then resumes', async () => {
    const s = songs[13]!
    const r = await file(member, { kind: 'edit', mediaId: s.id, proposed: { artist: `Fresh Artist ${RUN}` } })
    const id = (await json<{ id: number }>(r)).id
    expect((await req(reviewer, `/api/requests/${id}/decision`, { json: { decision: 'approve' } })).status).toBe(200)
    const parked = await waitFor(async () => {
      const v = await json<{ awaitingArtistId: number | null; status: string }>(await req(member, `/api/requests/${id}`))
      return v.awaitingArtistId ? v : null
    })
    expect(parked.status).toBe('approved')
    const aid = parked.awaitingArtistId!
    expect((await ownerSql()`SELECT status, folder FROM artists WHERE id = ${aid}`)[0]).toMatchObject({ status: 'pending', folder: `Fresh Artist ${RUN}` })
    expect((await byId(s.id))!.artist).toBe(artistName) // nothing written yet
    expect((await req(member, `/api/requests/artists/${aid}/decision`, { json: { decision: 'approve' } })).status).toBe(403)
    expect((await req(reviewer, `/api/requests/artists/999999/decision`, { json: { decision: 'approve' } })).status).toBe(404)
    const [x, y] = await Promise.all([
      req(reviewer, `/api/requests/artists/${aid}/decision`, { json: { decision: 'approve' } }),
      req(reviewer, `/api/requests/artists/${aid}/decision`, { json: { decision: 'approve' } }),
    ])
    expect([x.status, y.status].sort()).toEqual([200, 409])
    // the worker's sweep resumes it: metadata written, then a move to the new folder is queued
    await waitFor(async () => (await byId(s.id))?.artist === `Fresh Artist ${RUN}`)
    const mv = await waitFor(async () => (await ownerSql()`SELECT payload FROM jobs WHERE kind = 'move' AND payload->>'requestId' = ${String(id)}`)[0])
    expect(mv.payload).toMatchObject({ mediaId: s.id, toDir: `${PREFIX}Music/Artists/Fresh Artist ${RUN}` })
  })

  it('manager library actions are manage-only, validated, audited and applied by the worker', async () => {
    const s = songs[14]!
    expect((await req(member, `/api/library/${s.id}`, { method: 'PATCH', json: { genre: 'x' } })).status).toBe(403)
    expect((await req(member, `/api/library/${s.id}/playlists`, { method: 'PUT', json: { playlistIds: [2] } })).status).toBe(403)
    expect((await req(member, `/api/library/${s.id}/archive`, { json: {} })).status).toBe(403)
    expect((await req(member, '/api/archive')).status).toBe(403)
    expect((await req(reviewer, `/api/library/${refused[0]}`, { method: 'PATCH', json: { genre: 'x' } })).status).toBe(404)
    expect((await req(reviewer, `/api/library/${s.id}`, { method: 'PATCH', json: { artist: `Nobody ${RUN}` } })).status).toBe(409)
    expect((await req(reviewer, `/api/library/${s.id}`, { method: 'PATCH', json: { genre: 'x', path: 'y' } })).status).toBe(400)
    const e = await req(reviewer, `/api/library/${s.id}`, { method: 'PATCH', json: { genre: 'Managed' } })
    expect(e.status).toBe(202)
    await waitFor(async () => (await byId(s.id))?.genre === 'Managed')
    expect((await req(reviewer, `/api/library/${s.id}/playlists`, { method: 'PUT', json: { playlistIds: [3] } })).status).toBe(400)
    expect((await req(reviewer, `/api/library/${s.id}/playlists`, { method: 'PUT', json: { playlistIds: [] } })).status).toBe(202)
    await waitFor(async () => ((await byId(s.id))?.playlists ?? [{ id: 0 }]).length === 0)
    expect((await req(reviewer, '/api/archive/999999/restore', { method: 'POST' })).status).toBe(404)
    expect((await req(reviewer, '/api/archive')).status).toBe(200)
    const audits = await ownerSql()`SELECT action FROM audit_log WHERE target_id = ${String(s.id)} AND action LIKE 'library.%'`
    expect(new Set(audits.map((a) => a.action))).toEqual(new Set(['library.edit', 'library.playlists']))
  })

  it('an approved removal is archived by the worker inside the scan window', { timeout: 200_000 }, async () => {
    const s = songs[4]!
    const r = await file(member, { kind: 'removal', mediaId: s.id, reason: 'Left the label' })
    const id = (await json<{ id: number }>(r)).id
    expect((await req(reviewer, `/api/requests/${id}/decision`, { json: { decision: 'approve' } })).status).toBe(200)
    const moved = await waitFor(async () => {
      const f = await byId(s.id)
      return f?.path === `${PREFIX}Removed/${s.id}/song 04.mp3` ? f : null
    }, 190_000, 1000)
    expect(moved.playlists).toEqual([])
    await waitFor(async () => (await ownerSql()`SELECT status FROM requests WHERE id = ${id}`)[0]!.status === 'verifying')
    const a = (await ownerSql()`SELECT id FROM archive WHERE media_id = ${s.id} AND status = 'archived'`)[0]!
    expect((await file(member, { kind: 'edit', mediaId: s.id, proposed: { title: 'x' } })).status).toBe(404) // archived: not requestable
    const list = await json<{ id: number }[]>(await req(reviewer, '/api/archive'))
    expect(list.some((x) => x.id === a.id)).toBe(true)
    expect((await req(reviewer, `/api/archive/${a.id}/restore`, { method: 'POST' })).status).toBe(202)
  })

  it('admin settings: admin only, validated per key, audited', async () => {
    const put = (jar: Jar, body: unknown) => req(jar, '/api/admin/settings', { method: 'PUT', json: body })
    expect((await put(reviewer, { key: 'auto_close_days', value: 5 })).status).toBe(403)
    expect((await put(admin, { key: 'playlist_names', value: { '2': '1General Rotation', '3': 'Night' } })).status).toBe(200)
    expect((await put(admin, { key: 'station_id', value: 7 })).status).toBe(400)
    expect((await put(admin, { key: 'auto_close_days', value: 0 })).status).toBe(400)
    expect((await put(admin, { key: 'default_playlist_ids', value: [3] })).status).toBe(400) // not assignable
    expect((await put(admin, { key: 'discord_invite_url', value: 'https://discord.gg/efm' })).status).toBe(200)
    expect((await put(admin, { key: 'rights_attestation', value: { version: 'v2', text: 'I have the rights.' } })).status).toBe(200)
    const s = Object.fromEntries((await ownerSql()`SELECT key, value, updated_by FROM settings WHERE key IN ('playlist_names', 'discord_invite_url')`).map((r) => [r.key, r]))
    expect(s.playlist_names!.value).toEqual({ '2': '1General Rotation', '3': 'Night' })
    expect(s.discord_invite_url!.updated_by).toBe(ADMIN_ID)
    const au = await ownerSql()`SELECT detail FROM audit_log WHERE action = 'settings.update' AND target_id = 'playlist_names' ORDER BY id DESC LIMIT 1`
    expect(au[0]!.detail).toMatchObject({ after: { '3': 'Night' } })
  })

  it('role bindings: admin only; review/manage only (never admin); audited', async () => {
    const role = `9${String(Date.now()).slice(-12)}00000`
    expect((await req(reviewer, '/api/admin/role-bindings', { json: { roleId: role, permission: 'review' } })).status).toBe(403)
    expect((await req(admin, '/api/admin/role-bindings', { json: { roleId: role, permission: 'admin' } })).status).toBe(400)
    expect((await req(admin, '/api/admin/role-bindings', { json: { roleId: 'x', permission: 'review' } })).status).toBe(400)
    const add = await req(admin, '/api/admin/role-bindings', { json: { roleId: role, permission: 'review', note: 'test' } })
    expect(add.status).toBe(201)
    const { id } = await json<{ id: number }>(add)
    expect((await req(admin, '/api/admin/role-bindings', { json: { roleId: role, permission: 'review' } })).status).toBe(409)
    expect((await req(admin, `/api/admin/role-bindings/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await req(admin, `/api/admin/role-bindings/${id}`, { method: 'DELETE' })).status).toBe(404)
    const au = await ownerSql()`SELECT action FROM audit_log WHERE target_type = 'role_binding' AND target_id = ${String(id)} ORDER BY id`
    expect(au.map((a) => a.action)).toEqual(['role_bindings.add', 'role_bindings.remove'])
  })
})
