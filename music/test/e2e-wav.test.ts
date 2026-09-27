// v0.3.0 WAV uploads end to end through the REAL containers: the tus route
// caps by the declared type, the network-less probe converts a >35 MB WAV to a
// CBR 320 kbps MP3 (which replaces it under the upload id, and the staging
// quota follows), the member edits + submits, a reviewer approves, the
// running worker has the probe finalize it (ID3 + APIC), uploads it to the
// mock AzuraCast and the ticket flow completes. Names and declared types
// never decide the format: a WAV named .mp3 is converted, an MP3 named .wav
// stays an MP3, and a >35 MB MP3 admitted as a WAV is refused and released.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import NodeID3 from 'node-id3'
import { describe, expect, it } from 'vitest'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { E2E } from './helpers/env'
import { fxBuf } from './helpers/fixtures'
import { apicV3, frameV3, tag, textV3 } from './helpers/id3'
import { control, type Jar, req } from './helpers/http'
import { mkArtist } from './helpers/p3'
import { declare, tusCreate, tusUpload } from './helpers/tus'
import { waitFor } from './helpers/wait'
import { chunk, simpleWav } from './helpers/wav'

const MB = 1024 * 1024
const REVIEWER_ROLE = '1144462744456794153'
let seq = 0
const newId = () => `7${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`
const uploadsDir = () => join(process.env.TEST_DATA_DIR!, 'staging/uploads')

type Item = { id: number; status: string; title: string | null; artist: string | null; probeError: string | null; hasCover: boolean; inputFormat: string | null; bitrate: number | null; durationS: number | null }

async function batchOf(jar: Jar): Promise<number> {
  const r = await req(jar, '/api/batches', { method: 'POST' })
  expect(r.status).toBe(201)
  return ((await r.json()) as { id: number }).id
}

async function add(jar: Jar, batchId: number, data: Buffer, filetype: string): Promise<{ itemId: number; uploadId: string }> {
  const uploadId = await tusUpload(jar, data, 8 * MB, declare(filetype))
  const r = await req(jar, `/api/batches/${batchId}/items`, { json: { uploadId } })
  expect(r.status).toBe(201)
  return { itemId: ((await r.json()) as { id: number }).id, uploadId }
}

async function settled(jar: Jar, itemId: number, ms = 120_000): Promise<Item> {
  return waitFor(async () => {
    const it = (await (await req(jar, `/api/items/${itemId}`)).json()) as Item
    return it.status !== 'probing' ? it : null
  }, ms, 1000)
}

function ffprobe(file: string) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString()) as {
    format: { format_name: string }
    streams: { codec_type: string; codec_name: string; bit_rate?: string; sample_rate?: string; channels?: number }[]
  }
}

describe.skipIf(!E2E())('WAV uploads through the real containers (v0.3.0)', () => {
  it('tus creation caps by the declared type: WAV ≤ 250 MB, MP3 / undeclared ≤ 35 MB', async () => {
    const a = await loginOk({ id: newId() })
    const wav = await tusCreate(a, 250 * MB + 1, declare('audio/wav'))
    expect(wav.status).toBe(413)
    expect(await wav.text()).toContain('wav_upload_too_large')
    for (const h of [declare('audio/mpeg'), {}, declare('audio/flac'), { 'upload-metadata': 'filetype not-base64!' }]) {
      const r = await tusCreate(a, 35 * MB + 1, h)
      expect(r.status, JSON.stringify(h)).toBe(413)
      expect(await r.text()).toContain('upload_too_large')
    }
    // exactly 250 MB declared as a WAV is admitted (and terminated again)
    const ok = await tusCreate(a, 250 * MB, declare('audio/x-wav'))
    expect(ok.status).toBe(201)
    const loc = ok.headers.get('location')!
    expect((await req(a, loc, { method: 'DELETE', headers: { 'tus-resumable': '1.0.0' } })).status).toBe(204)
    // an admin-lowered WAV cap applies at creation
    const prev = (await ownerSql()`SELECT value FROM settings WHERE key = 'caps'`)[0]?.value
    await ownerSql()`UPDATE settings SET value = value || ${ownerSql().json({ maxWavUploadBytes: 50 * MB })} WHERE key = 'caps'`
    try {
      const low = await tusCreate(a, 50 * MB + 1, declare('audio/wav'))
      expect(low.status).toBe(413)
      expect((await tusCreate(a, 50 * MB, declare('audio/wav'))).status).toBe(201)
    } finally {
      await ownerSql()`UPDATE settings SET value = ${ownerSql().json(prev as never)} WHERE key = 'caps'`
    }
  })

  it('a >35 MB WAV: upload → probe converts to 320k MP3 → prefill → submit → approve → finalize (ID3 + APIC) → AzuraCast → ticket', async () => {
    const ownerId = newId()
    const owner = await loginOk({ id: ownerId })
    await control('/__mock/tickets/member', { id: ownerId, member: true })
    const reviewer = await loginOk({ id: newId(), roles: [REVIEWER_ROLE] })
    const artist = `E2E Wav Artist ${Date.now().toString(36)}`
    await mkArtist(artist)

    // 250 s of 16-bit 44.1 kHz stereo (~44 MB) with an 'id3 ' chunk: tags + APIC
    const id3 = tag(3, [
      frameV3('TIT2', textV3('E2E Wav Title')),
      frameV3('TPE1', textV3(artist)),
      frameV3('TALB', textV3('E2E Wav Album')),
      frameV3('TCON', textV3('House')),
      frameV3('APIC', apicV3('image/png', fxBuf('cover.png'))),
    ])
    const wav = simpleWav({ seconds: 250, after: [chunk('id3 ', id3)] })
    expect(wav.length).toBeGreaterThan(35 * MB)

    const b = await batchOf(owner)
    const { itemId, uploadId } = await add(owner, b, wav, 'audio/wav')
    const it = await settled(owner, itemId)
    expect(it).toMatchObject({ status: 'pending', inputFormat: 'wav', bitrate: 320000, title: 'E2E Wav Title', artist, hasCover: true })
    expect(it.durationS).toBe(250)

    // The staged bytes are now the MP3 (the WAV is gone) and the quota follows.
    const staged = readFileSync(join(uploadsDir(), uploadId))
    expect(staged.toString('latin1', 0, 4)).not.toBe('RIFF')
    expect(staged.length).toBeLessThanOrEqual(35 * MB)
    const row = (await ownerSql()`SELECT u.length, u.status, i.probe_sha256, i.input_format FROM uploads u JOIN items i ON i.upload_id = u.id WHERE u.id = ${uploadId}`)[0]!
    expect(row).toMatchObject({ length: staged.length, status: 'attached', input_format: 'wav' })
    expect(row.probe_sha256).toBe(createHash('sha256').update(staged).digest('hex'))

    // The preview is that MP3.
    const p = (await (await req(owner, `/api/items/${itemId}/preview`)).json()) as { audioUrl: string; coverUrl: string | null }
    const a = await req(owner, p.audioUrl)
    expect(a.status).toBe(200)
    expect(a.headers.get('content-type')).toBe('audio/mpeg')
    expect(Buffer.from(await a.arrayBuffer()).equals(staged)).toBe(true)
    expect(p.coverUrl).toBeTruthy()

    // edit + submit + approve
    expect((await req(owner, `/api/items/${itemId}`, { method: 'PATCH', json: { title: 'E2E Wav Song' } })).status).toBe(200)
    expect((await req(owner, `/api/batches/${b}/submit`, { json: { attest: true, attestVersion: '2026-09-27' } })).status).toBe(200)
    expect((await req(reviewer, `/api/items/${itemId}/decision`, { json: { decision: 'approve' } })).status).toBe(200)

    const done = await waitFor(
      async () => {
        const r = (await ownerSql()`SELECT status, target_path, media_id, final_sha256 FROM items WHERE id = ${itemId}`)[0]!
        if (r.status === 'failed') throw new Error(`ingest failed: ${JSON.stringify((await ownerSql()`SELECT last_error FROM ingest_runs WHERE item_id = ${itemId}`)[0])}`)
        return r.status === 'verifying' || r.status === 'live' ? r : null
      },
      600_000,
      1000,
    )
    const path = `Portal-Test/Music/Artists/${artist}/${artist} - E2E Wav Song.mp3`
    expect(done.target_path).toBe(path)

    // The file finalize published (and the worker uploaded): 320 kbps MP3, clean ID3 + APIC.
    const run = (await ownerSql()`SELECT final_file FROM ingest_runs WHERE item_id = ${itemId}`)[0]!
    const finalPath = join(process.env.TEST_DATA_DIR!, 'staging/final', run.final_file as string)
    const final = readFileSync(finalPath)
    expect(createHash('sha256').update(final).digest('hex')).toBe(done.final_sha256)
    const j = ffprobe(finalPath)
    expect(j.format.format_name).toBe('mp3')
    expect(j.streams.filter((s) => s.codec_type === 'audio')).toEqual([expect.objectContaining({ codec_name: 'mp3', bit_rate: '320000', sample_rate: '44100', channels: 2 })])
    const t = NodeID3.read(final)
    expect(t).toMatchObject({ title: 'E2E Wav Song', artist, album: 'E2E Wav Album', genre: 'House' })
    expect((t.image as { imageBuffer: Buffer }).imageBuffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))

    // Mock AzuraCast received exactly those bytes (base64 length) at the path.
    const calls = (await control('/__mock/az/calls')) as { method: string; body?: { path?: string; file?: string } }[]
    const upload = calls.find((c) => c.method === 'POST' && c.body?.path === path)!
    expect(upload.body!.file).toBe(`<base64 ${4 * Math.ceil(final.length / 3)} chars>`)
    const files = (await control('/__mock/az/files')) as { id: number; path: string }[]
    expect(files.find((f) => f.path === path)!.id).toBe(done.media_id)
    // No WAV ever reached AzuraCast.
    expect(calls.some((c) => typeof c.body?.path === 'string' && /\.wav$/i.test(c.body.path))).toBe(false)

    // Ticket: opened on submit, summary + completed once every item is decided.
    const batch = await waitFor(async () => {
      const r = (await ownerSql()`SELECT status, ticket_id FROM batches WHERE id = ${b}`)[0]!
      return r.status === 'completed' ? r : null
    }, 180_000, 1000)
    const msgs = (await control('/__mock/tickets/messages')) as { key: string; body: string }[]
    expect(msgs.some((m) => m.key === `${batch.ticket_id}|summary:batch:${b}` && m.body.includes('Review complete'))).toBe(true)
  }, 900_000)

  it('names and declared types never decide the format; refusals release the staged bytes', async () => {
    const owner = await loginOk({ id: newId() })
    const b = await batchOf(owner)

    // a WAV "renamed .mp3" (declared audio/mpeg, ≤ 35 MB) is still converted
    const small = await add(owner, b, fxBuf('s16-44k-stereo.wav'), 'audio/mpeg')
    expect(await settled(owner, small.itemId)).toMatchObject({ status: 'pending', inputFormat: 'wav', bitrate: 320000, title: 'Wav Title' })

    // an MP3 "renamed .wav" (declared audio/wav) is accepted as the MP3 it is
    const mp3 = await add(owner, b, fxBuf('tagged-png.mp3'), 'audio/wav')
    expect(await settled(owner, mp3.itemId)).toMatchObject({ status: 'pending', inputFormat: 'mp3', bitrate: 128000 })
    expect(readFileSync(join(uploadsDir(), mp3.uploadId)).equals(fxBuf('tagged-png.mp3'))).toBe(true)

    // a >35 MB MP3 admitted under the WAV cap is refused by its actual type
    const big = await add(owner, b, fxBuf('big-36mb.mp3'), 'audio/wav')
    expect(await settled(owner, big.itemId)).toMatchObject({ status: 'rejected', probeError: 'mp3_too_large' })
    // … and an ADPCM WAV with a clear reason
    const adpcm = await add(owner, b, fxBuf('adpcm.wav'), 'audio/wav')
    expect(await settled(owner, adpcm.itemId)).toMatchObject({ status: 'rejected', probeError: 'wav_codec_unsupported' })

    for (const u of [big.uploadId, adpcm.uploadId]) {
      expect(existsSync(join(uploadsDir(), u))).toBe(false) // the probe deleted the bytes
      await waitFor(async () => (await ownerSql()`SELECT status FROM uploads WHERE id = ${u}`)[0]!.status === 'expired', 10_000)
    }
  }, 300_000)
})
