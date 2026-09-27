// v0.3.0 staging accounting for WAV uploads (DB level): a declared WAV is
// admitted up to its own cap and charged at its full length; when the probe
// reports the conversion, the upload row is re-charged at the MP3's size (the
// WAV is gone); a refusal whose bytes the probe deleted releases them.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '@/server/db/client'
import { DEFAULT_CAPS, MB } from '@/server/settings-defaults'
import { admitUpload, stagedBytes } from '@/server/uploads/caps'
import { collectProbeResults, type WorkerCtx } from '@/worker/handlers'
import { ownerSql } from './helpers/db'
import { DBENV } from './helpers/env'
import { mkBatch, mkUser } from './helpers/p3'

const db = () => getDb(process.env.TEST_APP_DATABASE_URL, 2)
const hex = () => randomUUID().replace(/-/g, '')

describe.skipIf(!DBENV())('WAV staging accounting (v0.3.0)', () => {
  afterAll(async () => {
    await closeDb()
  })

  it('admission: a declared WAV up to its (loaded) cap; the same length declared as MP3 is refused', async () => {
    const u = await mkUser()
    expect(await admitUpload(db(), u.id, hex(), 200 * MB, DEFAULT_CAPS, 'mp3')).toEqual({ status: 413, code: 'upload_too_large' })
    expect(await admitUpload(db(), u.id, hex(), 200 * MB, { ...DEFAULT_CAPS, maxWavUploadBytes: 100 * MB }, 'wav')).toEqual({ status: 413, code: 'wav_upload_too_large' })
    const id = hex()
    expect(await admitUpload(db(), u.id, id, 200 * MB, DEFAULT_CAPS, 'wav')).toBeNull()
    expect((await ownerSql()`SELECT length FROM uploads WHERE id = ${id}`)[0]!.length).toBe(200 * MB)
    // the WAV's full bytes count toward the per-user in-flight cap (1 GB)
    for (let i = 0; i < 4; i++) {
      await ownerSql()`UPDATE uploads SET status = 'complete' WHERE owner_user_id = ${u.id}`
      expect(await admitUpload(db(), u.id, hex(), 200 * MB, DEFAULT_CAPS, 'wav')).toBeNull()
    }
    await ownerSql()`UPDATE uploads SET status = 'complete' WHERE owner_user_id = ${u.id}`
    expect(await admitUpload(db(), u.id, hex(), 24 * MB + 1, DEFAULT_CAPS, 'wav')).toMatchObject({ status: 429, code: 'inflight_quota' })
    await ownerSql()`UPDATE uploads SET status = 'expired' WHERE owner_user_id = ${u.id}`
  })

  it('probe results: a converted WAV is re-charged at the MP3 size; a released refusal expires the upload', async () => {
    const out = mkdtempSync(join(tmpdir(), 'wavacct-'))
    const ctx = { db: db(), spoolOutDir: out } as unknown as WorkerCtx
    const u = await mkUser()
    const b = await mkBatch(u.id, { status: 'draft' })
    const mk = async (length: number) => {
      const upload = hex()
      const req = randomUUID()
      await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status) VALUES (${upload}, ${u.id}, ${length}, 'attached')`
      const [it] = await ownerSql()`INSERT INTO items (batch_id, owner_user_id, status, upload_id, probe_request_id) VALUES (${b}, ${u.id}, 'probing', ${upload}, ${req}) RETURNING id`
      return { upload, req, item: it!.id as number }
    }
    const conv = await mk(200 * MB)
    const refused = await mk(150 * MB)
    const kept = await mk(10 * MB)
    const before = await stagedBytes(db())
    const base = { v: 1, source: 'in-web', type: 'probe' }
    const tags = { title: 'T', artist: 'A', album: null, genre: null, year: null }
    writeFileSync(join(out, `${conv.req}.json`), JSON.stringify({ ...base, id: conv.req, ok: true, sha256: 'a'.repeat(64), size: 9 * MB, durationS: 240, bitrate: 320000, tags, cover: null, flags: ['converted_from_wav'], inputFormat: 'wav' }))
    writeFileSync(join(out, `${refused.req}.json`), JSON.stringify({ ...base, id: refused.req, ok: false, error: 'wav_codec_unsupported', released: true }))
    writeFileSync(join(out, `${kept.req}.json`), JSON.stringify({ ...base, id: kept.req, ok: false, error: 'interrupted' }))
    await collectProbeResults(ctx)

    const row = async (x: { upload: string; item: number }) =>
      (await ownerSql()`SELECT u.length, u.status AS ustatus, i.status, i.input_format, i.probe_error, i.bitrate FROM uploads u JOIN items i ON i.upload_id = u.id WHERE u.id = ${x.upload}`)[0]!
    expect(await row(conv)).toMatchObject({ length: 9 * MB, ustatus: 'attached', status: 'pending', input_format: 'wav', bitrate: 320000 })
    expect(await row(refused)).toMatchObject({ length: 150 * MB, ustatus: 'expired', status: 'rejected', probe_error: 'wav_codec_unsupported' })
    // not released by the probe (e.g. interrupted): the bytes may still be on disk, so they stay charged
    expect(await row(kept)).toMatchObject({ ustatus: 'attached', status: 'rejected', probe_error: 'interrupted' })
    const after = await stagedBytes(db())
    expect(before.uploads - after.uploads).toBe(200 * MB - 9 * MB + 150 * MB)
  })

  it('an MP3 result from an older probe (no inputFormat) is recorded as mp3 and keeps its length', async () => {
    const out = mkdtempSync(join(tmpdir(), 'wavacct-'))
    const u = await mkUser()
    const b = await mkBatch(u.id, { status: 'draft' })
    const upload = hex()
    const req = randomUUID()
    await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status) VALUES (${upload}, ${u.id}, ${5 * MB}, 'attached')`
    await ownerSql()`INSERT INTO items (batch_id, owner_user_id, status, upload_id, probe_request_id) VALUES (${b}, ${u.id}, 'probing', ${upload}, ${req})`
    writeFileSync(join(out, `${req}.json`), JSON.stringify({ v: 1, source: 'in-web', type: 'probe', id: req, ok: true, sha256: 'b'.repeat(64), size: 5 * MB, durationS: 200, bitrate: 192000, tags: { title: 'T', artist: 'A', album: null, genre: null }, cover: null, flags: [] }))
    await collectProbeResults({ db: db(), spoolOutDir: out } as unknown as WorkerCtx)
    const r = (await ownerSql()`SELECT u.length, i.status, i.input_format FROM uploads u JOIN items i ON i.upload_id = u.id WHERE u.id = ${upload}`)[0]!
    expect(r).toMatchObject({ length: 5 * MB, status: 'pending', input_format: 'mp3' })
  })
})
