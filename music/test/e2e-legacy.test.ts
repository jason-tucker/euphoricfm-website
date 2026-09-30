// v0.3.6 end to end through the real web and worker containers: the
// manager's "Archive the UNRELEASED folder" (dry run by the worker, then
// confirm), the worker importing a file in the scan window, the Archived
// songs page per role (members see only their own or linked songs), member
// links, and the release of an Unreleased song into an artist folder.
import { beforeAll, describe, expect, it } from 'vitest'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { idMaker, REVIEWER_ROLE } from './helpers/e2e'
import { E2E } from './helpers/env'
import { control, Jar, req } from './helpers/http'
import { waitFor } from './helpers/wait'

const PREFIX = 'Portal-Test/'
const L = `${PREFIX}UNRELEASED-DO NOT ADD TO ROTATION`
const ADMIN_ID = '117501528641634310'
const RUN = Date.now().toString(36)
const newId = idMaker('3')

type Media = { id: number; path: string; title: string; playlists: { id: number }[] }
type Plan = { id: string; status: string; plan?: { files: { mediaId: number; path: string; dest: string; playlistIds: number[]; action: string }[] } }

describe.skipIf(!E2E())('v0.3.6 UNRELEASED import and Archived songs through the real containers', () => {
  let member: Jar
  let memberId: string
  let manager: Jar
  let admin: Jar
  let a: Media
  let b: Media
  let archiveId: number
  const folder = `E2E Released ${RUN}`

  const files = async () => (await control('/__mock/az/files')) as Media[]
  const byId = async (id: number) => (await files()).find((f) => f.id === id)
  const html = async (jar: Jar, path: string) => {
    const r = await req(jar, path)
    return { status: r.status, text: r.status === 200 ? (await r.text()).replace(/<!-- -->/g, '') : '' }
  }

  beforeAll(async () => {
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('station_playlist_ids', '[2,3,5]'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    await ownerSql()`INSERT INTO artists (name, folder, status) VALUES (${folder}, ${folder}, 'active')`
    // `a` sorts first in the plan, so its job runs first.
    await control('/__mock/az/seed', {
      files: [
        { path: `${L}/a-e2e-${RUN}.m4a`, title: `E2E Unreleased ${RUN}`, artist: folder, playlists: [2] },
        { path: `${L}/b-e2e-${RUN}.mp3`, title: `E2E Second ${RUN}`, artist: folder, playlists: [] },
      ],
    })
    const all = await files()
    a = all.find((f) => f.path === `${L}/a-e2e-${RUN}.m4a`)!
    b = all.find((f) => f.path === `${L}/b-e2e-${RUN}.mp3`)!
    memberId = newId()
    member = await loginOk({ id: memberId })
    manager = await loginOk({ id: newId(), roles: [REVIEWER_ROLE] })
    admin = await loginOk({ id: ADMIN_ID })
  })

  it('dry run (worker, read-only) then confirm (manager): exactly the planned files are queued, paced, once; members cannot', { timeout: 240_000 }, async () => {
    expect((await req(member, '/api/admin/legacy-import')).status).toBe(403)
    expect((await req(member, '/api/admin/legacy-import', { json: { action: 'dry_run' } })).status).toBe(403)
    const adminPage = await html(admin, '/admin')
    expect(adminPage.text).toContain('Archive the UNRELEASED folder')
    // Writes that name the UNRELEASED folder (other tests' leftover jobs may write elsewhere).
    const legacyWrites = async () => ((await control('/__mock/az/calls')) as { method: string; body?: unknown }[]).filter((c) => c.method !== 'GET' && JSON.stringify(c.body ?? '').includes('UNRELEASED')).length
    const writes0 = await legacyWrites()
    const d = await req(manager, '/api/admin/legacy-import', { json: { action: 'dry_run' } })
    expect(d.status).toBe(202)
    const { planId } = (await d.json()) as { planId: string }
    const state = await waitFor(async () => {
      const s = (await (await req(manager, '/api/admin/legacy-import')).json()) as { plan: Plan }
      return s.plan?.id === planId && s.plan.status === 'ready' ? s.plan : null
    }, 60_000)
    const pa = state.plan!.files.find((f) => f.mediaId === a.id)!
    expect(pa).toMatchObject({ path: a.path, dest: `${PREFIX}Removed/${a.id}/a-e2e-${RUN}.m4a`, playlistIds: [2], action: 'archive' })
    expect(state.plan!.files.find((f) => f.mediaId === b.id)).toMatchObject({ action: 'archive', playlistIds: [] })
    expect(await legacyWrites()).toBe(writes0) // the dry run wrote nothing
    expect((await req(manager, '/api/admin/legacy-import', { json: { action: 'run', planId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(409)

    const r = await req(manager, '/api/admin/legacy-import', { json: { action: 'run', planId } })
    expect(r.status).toBe(202)
    const queued = (await r.json()) as { queued: number }
    expect(queued.queued).toBe(state.plan!.files.filter((f) => f.action === 'archive' || f.action === 'refuse_events').length)
    expect(await (await req(manager, '/api/admin/legacy-import', { json: { action: 'run', planId } })).json()).toMatchObject({ error: 'plan_already_run' })
    const jobs = await ownerSql()`SELECT payload, run_after FROM jobs WHERE kind = 'import_legacy_archive' AND payload->>'planId' = ${planId} ORDER BY run_after`
    expect(jobs[0]!.payload).toMatchObject({ mediaId: a.id, path: a.path })
    try {
      // The live worker archives `a` in a scan window: same id, out of rotation.
      const moved = await waitFor(async () => {
        const f = await byId(a.id)
        return f?.path === `${PREFIX}Removed/${a.id}/a-e2e-${RUN}.m4a` ? f : null
      }, 200_000, 1000)
      expect(moved.playlists).toEqual([])
      const row = await waitFor(async () => (await ownerSql()`SELECT * FROM archive WHERE media_id = ${a.id} AND status = 'archived'`)[0], 30_000)
      expect(row).toMatchObject({ origin: 'legacy_unreleased', original_path: a.path })
      archiveId = row.id as number
    } finally {
      // Keep the rest of the harness quiet: the later files' jobs are dropped.
      await ownerSql()`UPDATE jobs SET status = 'done' WHERE kind = 'import_legacy_archive' AND status = 'queued'`
      await waitFor(async () => (await ownerSql()`SELECT count(*)::int AS n FROM jobs WHERE kind = 'import_legacy_archive' AND status = 'running'`)[0]!.n === 0, 60_000)
      await ownerSql()`DELETE FROM settings WHERE key = 'legacy_import_slot'`
    }
    expect((await byId(b.id))!.path).toBe(b.path) // not yet: one per window
  })

  it('Archived songs: members see only their own or linked songs (read-only); managers link, audited', async () => {
    const before = await html(member, '/library/archived')
    expect(before.status).toBe(200)
    expect(before.text).not.toContain(`E2E Unreleased ${RUN}`)
    const staff = await html(manager, '/library/archived')
    expect(staff.text).toContain(`E2E Unreleased ${RUN}`)
    expect(staff.text).toContain('Unreleased')
    expect(staff.text).toContain('Release…')
    expect(staff.text).toContain('Link a member…')
    // A manager who is not an admin reaches the import here (not on /admin).
    expect((await html(manager, '/admin')).text).not.toContain('Archive the UNRELEASED folder')
    expect(staff.text).toContain('Archive the UNRELEASED folder')
    expect(before.text).not.toContain('Archive the UNRELEASED folder')
    // members: no manager routes
    expect((await req(member, `/api/archive/${archiveId}/link`, { method: 'PUT', json: { userId: 'x' } })).status).toBe(403)
    expect((await req(member, `/api/archive/${archiveId}/release`, { json: { artist: folder, playlistIds: [] } })).status).toBe(403)
    expect((await req(member, '/api/archive/link-candidates?q=ab')).status).toBe(403)
    const [u] = await ownerSql()`SELECT id FROM "user" WHERE discord_id = ${memberId}`
    const link = await req(manager, `/api/archive/${archiveId}/link`, { method: 'PUT', json: { userId: u!.id } })
    expect(link.status).toBe(200)
    const after = await html(member, '/library/archived')
    expect(after.text).toContain(`E2E Unreleased ${RUN}`)
    expect(after.text).toContain('Unreleased')
    expect(after.text).not.toContain('Release…')
    expect(after.text).not.toContain(`Removed/${a.id}`) // no paths for members
    expect(after.text).not.toContain('Link a member')
    // V-1: a removal reason someone else wrote is staff-only; the member's
    // row says "Removed from the station" instead.
    const mid = 900_000_000 + Math.floor(Math.random() * 1_000_000)
    await ownerSql()`INSERT INTO archive (media_id, original_path, archived_path, reason, linked_user_id, status, origin) VALUES (${mid}, ${`${PREFIX}Music/Artists/${folder}/v1-${RUN}.mp3`}, ${`${PREFIX}Removed/${mid}/v1-${RUN}.mp3`}, ${`Manager-only note ${RUN}`}, ${u!.id}, 'archived', 'portal')`
    try {
      const mv = await html(member, '/library/archived')
      expect(mv.text).toContain(`v1-${RUN}.mp3`)
      expect(mv.text).toContain('Removed from the station')
      expect(mv.text).not.toContain(`Manager-only note ${RUN}`)
      expect((await html(manager, '/library/archived')).text).toContain(`Manager-only note ${RUN}`)
    } finally {
      await ownerSql()`DELETE FROM archive WHERE media_id = ${mid}`
    }
    const au = await ownerSql()`SELECT actor_discord_id, detail FROM audit_log WHERE action = 'archive.link' AND target_id = ${String(archiveId)}`
    expect(au[0]!.detail).toMatchObject({ userId: u!.id, previousUserId: null })
    expect((await req(manager, `/api/archive/${archiveId}/link`, { method: 'DELETE' })).status).toBe(200)
    expect((await html(member, '/library/archived')).text).not.toContain(`E2E Unreleased ${RUN}`)
  })

  it('release: Restore is refused for an Unreleased song; the manager releases it into an artist folder with explicit playlists; the worker moves it', { timeout: 240_000 }, async () => {
    expect((await req(manager, `/api/archive/${archiveId}/restore`, { method: 'POST' })).status).toBe(409)
    expect((await req(manager, `/api/archive/${archiveId}/release`, { json: { artist: `Nobody ${RUN}`, playlistIds: [] } })).status).toBe(409) // artist_unknown
    const r = await req(manager, `/api/archive/${archiveId}/release`, { json: { artist: folder, playlistIds: [2] } })
    expect(r.status).toBe(202)
    // The worker moves the file, THEN writes the playlists (two AzuraCast
    // calls, worker/requests/jobs.ts releaseMedia steps 2 and 3), and marks
    // the row 'restored' only after verifying both. Waiting for the path
    // alone could read the file between the two writes (playlists []).
    await waitFor(async () => (await ownerSql()`SELECT status FROM archive WHERE id = ${archiveId}`)[0]!.status === 'restored', 230_000, 1000)
    const moved = (await byId(a.id))!
    expect(moved.path).toBe(`${PREFIX}Music/Artists/${folder}/a-e2e-${RUN}.m4a`)
    expect(moved.playlists.map((p) => p.id)).toEqual([2])
  })
})
