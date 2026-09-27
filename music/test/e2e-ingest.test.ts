// End-to-end P3 through the REAL containers: member edits + submits (new
// artist), a reviewer approves the new artist (folder) and the song, the
// running worker has the network-less probe finalize it (sha chain), waits
// for the clock-only scan window, uploads under Portal-Test/, sets the
// playlists, snapshots, and later posts the batch summary + `completed`.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { E2E } from './helpers/env'
import { fxBuf } from './helpers/fixtures'
import { control, req } from './helpers/http'
import { tusUpload } from './helpers/tus'
import { waitFor } from './helpers/wait'

const REVIEWER_ROLE = '1144462744456794153'
let seq = 0
const newId = () => `4${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`

describe.skipIf(!E2E())('P3 ingest through the real worker + probe', () => {
  it('edit → submit → approve new artist + song → finalize → window upload → verifying → summary', async () => {
    const ownerId = newId()
    const owner = await loginOk({ id: ownerId })
    await control('/__mock/tickets/member', { id: ownerId, member: true })
    const reviewer = await loginOk({ id: newId(), roles: [REVIEWER_ROLE] })

    const b = (await (await req(owner, '/api/batches', { method: 'POST' })).json()) as { id: number }
    const uploadId = await tusUpload(owner, fxBuf('tagged-png.mp3'))
    const added = (await (await req(owner, `/api/batches/${b.id}/items`, { json: { uploadId } })).json()) as { id: number }
    await waitFor(async () => ((await (await req(owner, `/api/items/${added.id}`)).json()) as { status: string }).status === 'pending', 45_000)

    const artist = `E2E Artist ${Date.now().toString(36)}`
    const patched = await req(owner, `/api/items/${added.id}`, { method: 'PATCH', json: { artist, title: 'E2E Song' } })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ artist, title: 'E2E Song' })
    expect((await req(owner, `/api/batches/${b.id}/submit`, { json: { attest: true, attestVersion: '2026-09-27' } })).status).toBe(200)
    expect((await req(owner, `/api/items/${added.id}`, { method: 'PATCH', json: { title: 'too late' } })).status).toBe(409)

    const [na] = await ownerSql()`SELECT id, prefill FROM items WHERE batch_id = ${b.id} AND kind = 'new_artist'`
    expect(na!.prefill).toEqual({ proposedFolder: artist })
    expect((await req(reviewer, `/api/items/${na!.id}/decision`, { json: { decision: 'approve', folder: artist } })).status).toBe(200)
    expect((await req(reviewer, `/api/items/${added.id}/decision`, { json: { decision: 'approve' } })).status).toBe(200)

    // Up to ~2 min for the scan window, plus the probe's finalize.
    const it1 = await waitFor(
      async () => {
        const r = (await ownerSql()`SELECT status, target_path, media_id, final_sha256 FROM items WHERE id = ${added.id}`)[0]!
        if (r.status === 'failed') throw new Error(`ingest failed: ${JSON.stringify((await ownerSql()`SELECT last_error FROM ingest_runs WHERE item_id = ${added.id}`)[0])}`)
        return r.status === 'verifying' || r.status === 'live' ? r : null
      },
      240_000,
      1000,
    )
    const path = `Portal-Test/Music/Artists/${artist}/${artist} - E2E Song.mp3`
    expect(it1.target_path).toBe(path)
    const files = (await control('/__mock/az/files')) as { id: number; path: string; playlists: { id: number }[] }[]
    const f = files.find((x) => x.path === path)!
    expect(f.id).toBe(it1.media_id)
    expect(f.playlists.map((p) => p.id)).toEqual([2])

    // The sha chain: the bytes the probe published are the ones recorded.
    const run = (await ownerSql()`SELECT final_file, stage FROM ingest_runs WHERE item_id = ${added.id}`)[0]!
    const final = readFileSync(join(process.env.TEST_DATA_DIR!, 'staging/final', run.final_file as string))
    expect(createHash('sha256').update(final).digest('hex')).toBe(it1.final_sha256)
    // clean ID3 with the edited title (node-id3 writes UTF-16 text frames)
    expect(final.includes(Buffer.from('E2E Song', 'utf16le')) || final.includes(Buffer.from('E2E Song'))).toBe(true)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM media_snapshots WHERE item_id = ${added.id}`)[0]!.n).toBe(1)
    const upload = ((await control('/__mock/az/calls')) as { method: string; path: string; body?: { path?: string; file?: string } }[]).find(
      (c) => c.method === 'POST' && c.body?.path === path,
    )!
    expect(upload.body!.file).toBe(`<base64 ${4 * Math.ceil(final.length / 3)} chars>`)

    // Every item decided → summary message, then PATCH completed.
    const batch = await waitFor(async () => {
      const r = (await ownerSql()`SELECT status, ticket_id FROM batches WHERE id = ${b.id}`)[0]!
      return r.status === 'completed' ? r : null
    }, 120_000, 1000)
    const msgs = (await control('/__mock/tickets/messages')) as { key: string; body: string }[]
    expect(msgs.some((m) => m.key === `${batch.ticket_id}|summary:batch:${b.id}` && m.body.includes('Review complete'))).toBe(true)
    const t = ((await control('/__mock/tickets/tickets')) as { id: number; status: string }[]).find((x) => x.id === batch.ticket_id)!
    expect(t.status).toBe('completed')
  }, 420_000)
})
