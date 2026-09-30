// v0.3.5 fit-to-size end to end through the REAL containers: a 16-min 320 kbps
// MP3 (38 MB, over the final-file cap) is admitted under the 100 MB MP3 cap,
// the network-less probe re-encodes it to CBR 256 kbps (replacing it under the
// upload id; the staging quota follows), the tags and cover come from the
// original, the reviewers see "Re-encoded to 256 kbps to fit" (review page,
// queue, ticket card), and after approval finalize + the worker ship a
// ≤ 35 MiB MP3 with ID3 + APIC to the mock AzuraCast. Also: the stale
// production caps row (maxUploadBytes 35 MB, no maxMp3UploadBytes) no longer
// keeps the submit page or the tus admission at 35 MB.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import NodeID3 from 'node-id3'
import { describe, expect, it } from 'vitest'
import { AUDIO_BUDGET_BYTES, MAX_UPLOAD_BYTES } from '@/lib/fit'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { ATTEST, ffprobe, html, idMaker, memberOf, REVIEWER_ROLE, waitIngested } from './helpers/e2e'
import { E2E } from './helpers/env'
import { fxBuf } from './helpers/fixtures'
import { apicV3, frameV3, tag, textV3 } from './helpers/id3'
import { control, req } from './helpers/http'
import { mkArtist } from './helpers/p3'
import { declare, tusCreate, tusUpload } from './helpers/tus'
import { waitFor } from './helpers/wait'

const MB = 1024 * 1024
const newId = idMaker('6')
const uploadsDir = () => join(process.env.TEST_DATA_DIR!, 'staging/uploads')

type Item = { id: number; status: string; title: string | null; artist: string | null; probeError: string | null; hasCover: boolean; inputFormat: string | null; transcodeKbps: number | null; bitrate: number | null; durationS: number | null }

describe.skipIf(!E2E())('fit-to-size through the real containers (v0.3.5)', () => {
  it('the stale production caps row (maxUploadBytes 36700160, no maxMp3UploadBytes) does not hold MP3 uploads at 35 MB', async () => {
    const a = await loginOk({ id: newId() })
    const prev = (await ownerSql()`SELECT value FROM settings WHERE key = 'caps'`)[0]?.value as Record<string, unknown>
    const { maxMp3UploadBytes: _drop, ...rest } = prev
    await ownerSql()`UPDATE settings SET value = ${ownerSql().json({ ...rest, maxUploadBytes: 36700160 } as never)} WHERE key = 'caps'`
    try {
      const submit = await html(a, '/submit')
      expect(submit).toContain('MP3: up to 100 MB each · 30 s to 24 min')
      expect(submit).toContain('WAV: up to 250 MB each · 30 s to 24 min')
      const ok = await tusCreate(a, 60 * MB, declare('audio/mpeg'))
      expect(ok.status).toBe(201)
      expect((await req(a, ok.headers.get('location')!, { method: 'DELETE', headers: { 'tus-resumable': '1.0.0' } })).status).toBe(204)
      expect((await tusCreate(a, 100 * MB + 1, declare('audio/mpeg'))).status).toBe(413)
      // an admin-lowered MP3 cap (the new key) applies to the page and the admission
      await ownerSql()`UPDATE settings SET value = value || ${ownerSql().json({ maxMp3UploadBytes: 50 * MB })} WHERE key = 'caps'`
      expect(await html(a, '/submit')).toContain('MP3: up to 50 MB each')
      expect((await tusCreate(a, 50 * MB + 1, declare('audio/mpeg'))).status).toBe(413)
    } finally {
      await ownerSql()`UPDATE settings SET value = ${ownerSql().json(prev as never)} WHERE key = 'caps'`
    }
  })

  it('a 38 MB MP3: upload → probe re-encodes to CBR 256k → prefill → submit (ticket says so) → review page says so → approve → finalize (ID3 + APIC) → AzuraCast gets ≤ 35 MiB', async () => {
    const ownerId = newId()
    const owner = await loginOk({ id: ownerId })
    await memberOf(ownerId)
    const reviewer = await loginOk({ id: newId(), roles: [REVIEWER_ROLE] })
    const artist = `E2E Fit Artist ${Date.now().toString(36)}`
    await mkArtist(artist)

    const id3 = tag(3, [
      frameV3('TIT2', textV3('E2E Fit Title')),
      frameV3('TPE1', textV3(artist)),
      frameV3('TALB', textV3('E2E Fit Album')),
      frameV3('TCON', textV3('Trance')),
      frameV3('APIC', apicV3('image/png', fxBuf('cover.png'))),
    ])
    const orig = Buffer.concat([id3, fxBuf('fit-16m-320k.mp3')])
    expect(orig.length).toBeGreaterThan(MAX_UPLOAD_BYTES)

    const b = ((await (await req(owner, '/api/batches', { method: 'POST' })).json()) as { id: number }).id
    const uploadId = await tusUpload(owner, orig, 8 * MB, declare('audio/mpeg'))
    const add = await req(owner, `/api/batches/${b}/items`, { json: { uploadId } })
    expect(add.status).toBe(201)
    const itemId = ((await add.json()) as { id: number }).id
    const it = await waitFor(async () => {
      const x = (await (await req(owner, `/api/items/${itemId}`)).json()) as Item
      return x.status !== 'probing' ? x : null
    }, 600_000, 1000)
    expect(it).toMatchObject({ status: 'pending', inputFormat: 'mp3', transcodeKbps: 256, bitrate: 256000, title: 'E2E Fit Title', artist, hasCover: true })
    expect(it.durationS).toBe(960)

    // The staged bytes are the re-encoded MP3 (the original is gone) and the quota follows.
    const staged = readFileSync(join(uploadsDir(), uploadId))
    expect(staged.length).toBeLessThanOrEqual(AUDIO_BUDGET_BYTES)
    const row = (await ownerSql()`SELECT u.length, u.status, i.probe_sha256, i.input_format, i.transcode_kbps FROM uploads u JOIN items i ON i.upload_id = u.id WHERE u.id = ${uploadId}`)[0]!
    expect(row).toMatchObject({ length: staged.length, status: 'attached', input_format: 'mp3', transcode_kbps: 256 })
    expect(row.probe_sha256).toBe(createHash('sha256').update(staged).digest('hex'))

    // The member's card data + submit; the ticket card tells the managers.
    expect((await req(owner, `/api/batches/${b}/submit`, { json: ATTEST })).status).toBe(200)
    const ticket = await waitFor(async () => {
      const all = (await control('/__mock/tickets/tickets')) as { externalRef: string; card: { lines: string[] } }[]
      return all.find((x) => x.externalRef === `batch:${b}`)
    }, 60_000, 500)
    expect(ticket.card.lines).toContain(`#${itemId} ${artist} - E2E Fit Title (Re-encoded to 256 kbps to fit)`)

    // Reviewers see it before approving: the item's review page and the queue.
    expect(await html(reviewer, `/review/items/${itemId}`)).toContain('Re-encoded to 256 kbps to fit')
    expect(await html(reviewer, '/review')).toContain('Re-encoded to 256 kbps to fit')

    expect((await req(reviewer, `/api/items/${itemId}/decision`, { json: { decision: 'approve' } })).status).toBe(200)
    const done = await waitIngested(itemId, 600_000)
    const path = `Portal-Test/Music/Artists/${artist}/${artist} - E2E Fit Title.mp3`
    expect(done.target_path).toBe(path)

    // The final file: ≤ 35 MiB, CBR 256k, clean ID3 + APIC from the original's tags / cover.
    const run = (await ownerSql()`SELECT final_file FROM ingest_runs WHERE item_id = ${itemId}`)[0]!
    const finalPath = join(process.env.TEST_DATA_DIR!, 'staging/final', run.final_file as string)
    const final = readFileSync(finalPath)
    expect(final.length).toBeLessThanOrEqual(MAX_UPLOAD_BYTES)
    expect(createHash('sha256').update(final).digest('hex')).toBe(done.final_sha256)
    const j = ffprobe(finalPath)
    expect(j.streams.filter((s) => s.codec_type === 'audio')).toEqual([expect.objectContaining({ codec_name: 'mp3', bit_rate: '256000', sample_rate: '44100', channels: 2 })])
    const t = NodeID3.read(final)
    expect(t).toMatchObject({ title: 'E2E Fit Title', artist, album: 'E2E Fit Album', genre: 'Trance' })
    expect((t.image as { imageBuffer: Buffer }).imageBuffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))

    // Mock AzuraCast received exactly those bytes (base64 length) at the path.
    const calls = (await control('/__mock/az/calls')) as { method: string; body?: { path?: string; file?: string } }[]
    const upload = calls.find((c) => c.method === 'POST' && c.body?.path === path)!
    expect(upload.body!.file).toBe(`<base64 ${4 * Math.ceil(final.length / 3)} chars>`)
    const files = (await control('/__mock/az/files')) as { id: number; path: string }[]
    expect(files.find((f) => f.path === path)!.id).toBe(done.media_id)

    // After the decision the review page still says what happened.
    expect(await html(reviewer, `/review/items/${itemId}`)).toContain('Re-encoded to 256 kbps to fit')
  }, 1_500_000)
})
