// v0.4.0 SoundCloud links end to end through the REAL containers: web (link
// check, limits, item + job) → worker (music-fetch request) → the real
// music-fetch service code (network_mode none; test/fetch-fake plays fixture
// files in place of yt-dlp and the artwork host) → worker (strict result
// checks, pre-fill) → the network-less probe (probe_fetch: AAC → MP3 on the fit
// ladder, artwork → JPEG) → member edits + submits with the rights attestation
// → ticket card (license + source URL) → reviewer approves → finalize → the
// mock AzuraCast receives a ≤ 35 MiB MP3 with tags and cover.
//
// Nothing here reaches SoundCloud or any production system.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import NodeID3 from 'node-id3'
import { beforeAll, describe, expect, it } from 'vitest'
import { AUDIO_BUDGET_BYTES, MAX_UPLOAD_BYTES } from '@/lib/fit'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { E2E, has } from './helpers/env'
import { control, type Jar, req } from './helpers/http'
import { mkArtist } from './helpers/p3'
import { scFx, scInfo } from './helpers/soundcloud'
import { waitFor } from './helpers/wait'

const REVIEWER_ROLE = '1144462744456794153'
let seq = 0
const newId = () => `7${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`
const run = Date.now().toString(36)
const FX = () => process.env.FETCH_FIXTURES_DIR!
const data = (p: string) => join(process.env.TEST_DATA_DIR!, p)

type Item = {
  id: number
  status: string
  title: string | null
  artist: string | null
  genre: string | null
  probeError: string | null
  hasCover: boolean
  inputFormat: string | null
  transcodeKbps: number | null
  bitrate: number | null
  durationS: number | null
  source: string
  fetchStage: string | null
  fetchLicense: string | null
  sourceUrl: string | null
}

// A track the fake yt-dlp will "download": /fixtures/<slug>.json (+ media, art).
function fixture(slug: string, fx: Record<string, unknown>, media?: { name: string; ext: string }, art?: string) {
  if (media) copyFileSync(scFx(media.name), join(FX(), `${slug}.${media.ext}`))
  if (art) {
    execFileSync('mkdir', ['-p', join(FX(), 'art')])
    copyFileSync(scFx(art), join(FX(), 'art', `artworks-${slug}-t500x500.jpg`))
  }
  writeFileSync(join(FX(), `${slug}.json`), JSON.stringify({ ...(media ? { audio: `${slug}.${media.ext}`, ext: media.ext } : {}), ...fx }))
}

async function html(jar: Jar, path: string): Promise<string> {
  const r = await req(jar, path)
  expect(r.status, path).toBe(200)
  return (await r.text()).replace(/<!-- -->/g, '')
}

async function addLink(jar: Jar, batch: number, url: string) {
  return req(jar, `/api/batches/${batch}/soundcloud`, { json: { url } })
}

async function settled(jar: Jar, id: number, ms = 300_000): Promise<Item> {
  return waitFor(
    async () => {
      const x = (await (await req(jar, `/api/items/${id}`)).json()) as Item
      return x.status !== 'probing' ? x : null
    },
    ms,
    1000,
  )
}

describe.skipIf(!E2E() || !has('FETCH_FIXTURES_DIR'))('SoundCloud links through the real containers (v0.4.0)', () => {
  let owner: Jar
  let ownerId: string
  let batch: number

  beforeAll(async () => {
    ownerId = newId()
    owner = await loginOk({ id: ownerId })
    await control('/__mock/tickets/member', { id: ownerId, member: true })
    batch = ((await (await req(owner, '/api/batches', { method: 'POST' })).json()) as { id: number }).id
  })

  it('refuses a non-SoundCloud link and a playlist before anything is queued', async () => {
    const bad = await addLink(owner, batch, 'https://evil.example/soundcloud.com/a/b')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'sc_bad_url' })
    const set = await addLink(owner, batch, 'https://soundcloud.com/some-artist/sets/an-album')
    expect(set.status).toBe(400)
    expect(await set.json()).toEqual({ error: 'sc_not_a_track' })
    expect((await ownerSql()`SELECT count(*)::int AS n FROM items WHERE batch_id = ${batch}`)[0]!.n).toBe(0)
    // the submit page shows the working box (not "Coming soon")
    const page = await html(owner, `/submit?batch=${batch}`)
    expect(page).toContain('Add from a SoundCloud link')
    expect(page).toContain('Add from SoundCloud')
    expect(page).not.toContain('Coming soon')
  })

  it('a 10-min AAC link: fetch → probe → MP3 320k + cover → pre-fill → edit → submit → ticket → approve → finalize → AzuraCast gets ≤ 35 MiB with tags + cover', async () => {
    const slug = `e2e-track-${run}`
    const artist = `E2E SC Artist ${run}`
    await mkArtist(artist)
    fixture(slug, { info: scInfo({ title: `SC ‮Title ${run}`, uploader: artist, duration: 600.1, genre: 'Deep House', license: 'cc-by-nc', art: `artworks-${slug}-t500x500.jpg` }) }, { name: 'sc-aac-10m.m4a', ext: 'm4a' }, 'sc-art.jpg')
    const reviewer = await loginOk({ id: newId(), roles: [REVIEWER_ROLE] })

    const canary0 = ((await control('/__mock/canary/hits')) as unknown[]).length
    const add = await addLink(owner, batch, `https://m.soundcloud.com/e2e-user/${slug}?si=abc123&utm_source=clipboard`)
    expect(add.status).toBe(201)
    const created = (await add.json()) as { id: number; url: string }
    expect(created.url).toBe(`https://soundcloud.com/e2e-user/${slug}`)
    const itemId = created.id

    const it1 = await settled(owner, itemId)
    expect(it1, JSON.stringify(it1)).toMatchObject({
      status: 'pending',
      source: 'soundcloud',
      fetchStage: null,
      fetchLicense: 'cc-by-nc',
      sourceUrl: `https://soundcloud.com/e2e-user/${slug}`,
      title: `SC Title ${run}`, // the bidi override is gone (music-fetch + clipTag)
      artist,
      genre: 'Deep House',
      inputFormat: 'aac',
      transcodeKbps: 320,
      bitrate: 320000,
      hasCover: true,
    })
    expect(Math.abs(it1.durationS! - 600)).toBeLessThanOrEqual(2)

    // Staging: the MP3 is under the item's upload id, the quota charges it,
    // and music-fetch dropped the raw download once the probe was done.
    const row = (await ownerSql()`SELECT i.upload_id, i.probe_sha256, i.fetch_request_id, u.length, u.status FROM items i JOIN uploads u ON u.id = i.upload_id WHERE i.id = ${itemId}`)[0]!
    const staged = readFileSync(data(`staging/uploads/${row.upload_id}`))
    expect(staged.length).toBeLessThanOrEqual(AUDIO_BUDGET_BYTES)
    expect(row).toMatchObject({ length: staged.length, status: 'attached' })
    expect(createHash('sha256').update(staged).digest('hex')).toBe(row.probe_sha256)
    await waitFor(async () => !existsSync(data(`staging/fetch/${row.fetch_request_id}`)), 30_000, 500)
    const fetchOut = JSON.parse(readFileSync(data(`spool/fetch/out/${row.fetch_request_id}.json`), 'utf8'))
    expect(fetchOut).toMatchObject({ status: 'ok', container: 'mp4', ffmpegFormat: 'mp4', canonicalUrl: `https://soundcloud.com/e2e-user/${slug}` })

    // The member sees the license and the conversion, and can edit the pre-fill.
    const page = await html(owner, `/submit?batch=${batch}`)
    expect(page).toContain(`SC Title ${run}`)
    const edit = await req(owner, `/api/items/${itemId}`, { method: 'PATCH', json: { title: `Edited SC Title ${run}`, album: 'SC Album' } })
    expect(edit.status).toBe(200)

    // Submit WITH the rights attestation (still required).
    expect((await req(owner, `/api/batches/${batch}/submit`, { json: { attest: false } })).status).toBe(400)
    expect((await req(owner, `/api/batches/${batch}/submit`, { json: { attest: true, attestVersion: '2026-09-27' } })).status).toBe(200)
    const ticket = await waitFor(async () => {
      const all = (await control('/__mock/tickets/tickets')) as { externalRef: string; card: { lines: string[] } }[]
      return all.find((x) => x.externalRef === `batch:${batch}`)
    }, 60_000, 500)
    expect(ticket.card.lines).toContain(`#${itemId} ${artist} - Edited SC Title ${run} (From SoundCloud (CC BY-NC); Converted from AAC (320 kbps MP3))`)
    expect(ticket.card.lines).toContain(`#${itemId} source: https://soundcloud.com/e2e-user/${slug}`)

    // Reviewers see where it came from, with its license.
    const rp = await html(reviewer, `/review/items/${itemId}`)
    expect(rp).toContain('From SoundCloud (CC BY-NC)')
    expect(rp).toContain(`href="https://soundcloud.com/e2e-user/${slug}"`)
    expect(await html(reviewer, '/review')).toContain('From SoundCloud (CC BY-NC)')

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
    const path = `Portal-Test/Music/Artists/${artist}/${artist} - Edited SC Title ${run}.mp3`
    expect(done.target_path).toBe(path)
    const run2 = (await ownerSql()`SELECT final_file FROM ingest_runs WHERE item_id = ${itemId}`)[0]!
    const final = readFileSync(data(`staging/final/${run2.final_file}`))
    expect(final.length).toBeLessThanOrEqual(MAX_UPLOAD_BYTES)
    expect(createHash('sha256').update(final).digest('hex')).toBe(done.final_sha256)
    const t = NodeID3.read(final)
    expect(t).toMatchObject({ title: `Edited SC Title ${run}`, artist, album: 'SC Album', genre: 'Deep House' })
    expect((t.image as { imageBuffer: Buffer }).imageBuffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    const calls = (await control('/__mock/az/calls')) as { method: string; body?: { path?: string; file?: string } }[]
    const upload = calls.find((c) => c.method === 'POST' && c.body?.path === path)!
    expect(upload.body!.file).toBe(`<base64 ${4 * Math.ceil(final.length / 3)} chars>`)
    // nothing ever called out of the probe or the fetch container
    expect(((await control('/__mock/canary/hits')) as unknown[]).length).toBe(canary0)
  }, 1_500_000)

  describe('rejections, each with a readable reason', () => {
    let b: number
    beforeAll(async () => {
      b = ((await (await req(owner, '/api/batches', { method: 'POST' })).json()) as { id: number }).id
    })

    const link = async (slug: string) => {
      const r = await addLink(owner, b, `https://soundcloud.com/e2e-user/${slug}`)
      expect(r.status).toBe(201)
      return ((await r.json()) as { id: number }).id
    }

    it('a private / removed track (yt-dlp refuses) → sc_extractor_failed', async () => {
      const slug = `e2e-private-${run}`
      fixture(slug, { stderr: `ERROR: [soundcloud] ${slug}: This track is private or not available`, exit: 1 })
      const x = await settled(owner, await link(slug))
      expect(x).toMatchObject({ status: 'rejected', probeError: 'sc_extractor_failed' })
      const page = await html(owner, `/submit?batch=${b}`)
      expect(page).toContain('may be private, removed')
    })

    it('longer than 24 min (SoundCloud says 25) → stopped on the info JSON alone → sc_too_long', async () => {
      const slug = `e2e-long-${run}`
      fixture(slug, { info: scInfo({ duration: 1500 }), sleep: 30 }, { name: 'sc-aac-40s.m4a', ext: 'm4a' })
      const t0 = Date.now()
      const x = await settled(owner, await link(slug))
      expect(x).toMatchObject({ status: 'rejected', probeError: 'sc_too_long' })
      // The fake would sleep 30 s: well under that proves the early stop. The
      // worker's idle poll (2 → 5 s, v0.4.1) can add ≤ 3 s at the job claim
      // and at the result, hence 28 s (was 25 s at a fixed 2 s poll).
      expect(Date.now() - t0).toBeLessThan(28_000)
    })

    it('a fetch that runs past music-fetch’s timeout → sc_timeout (the test stack runs it at 10 s)', async () => {
      const slug = `e2e-slow-${run}`
      fixture(slug, { info: scInfo({ duration: 40 }), sleep: 60 }, { name: 'sc-aac-40s.m4a', ext: 'm4a' })
      const x = await settled(owner, await link(slug))
      expect(x).toMatchObject({ status: 'rejected', probeError: 'sc_timeout' })
    })

    it('a download that is not audio at all (an HLS playlist) → music-fetch refuses it → sc_bad_media', async () => {
      const slug = `e2e-hls-${run}`
      const canary0 = ((await control('/__mock/canary/hits')) as unknown[]).length
      writeFileSync(join(FX(), `${slug}.m4a`), '#EXTM3U\n#EXT-X-TARGETDURATION:10\nhttp://mocks:4104/sc-egress/seg0.ts\n'.repeat(10))
      fixture(slug, { info: scInfo(), audio: `${slug}.m4a`, ext: 'm4a' })
      const x = await settled(owner, await link(slug))
      expect(x).toMatchObject({ status: 'rejected', probeError: 'sc_bad_media' })
      expect(((await control('/__mock/canary/hits')) as unknown[]).length).toBe(canary0)
    })

    it('the staging charge of a rejected link is released', async () => {
      const rows = await ownerSql()`SELECT u.status FROM items i JOIN uploads u ON u.id = i.upload_id WHERE i.batch_id = ${b} AND i.status = 'rejected'`
      expect(rows.length).toBeGreaterThanOrEqual(3)
      expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['expired']))
    })

    it('limits: the kill switch, then the daily cap (admin-lowered)', async () => {
      await ownerSql()`INSERT INTO settings (key, value) VALUES ('soundcloud_fetch_enabled', 'false'::jsonb) ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb`
      try {
        const off = await addLink(owner, b, `https://soundcloud.com/e2e-user/off-${run}`)
        expect(off.status).toBe(503)
        expect(await off.json()).toEqual({ error: 'sc_disabled' })
      } finally {
        await ownerSql()`DELETE FROM settings WHERE key = 'soundcloud_fetch_enabled'`
      }
      const prev = (await ownerSql()`SELECT value FROM settings WHERE key = 'caps'`)[0]?.value as Record<string, unknown>
      await ownerSql()`UPDATE settings SET value = value || ${ownerSql().json({ fetchesPerUserPerDay: 4 })} WHERE key = 'caps'`
      try {
        // this member added 5 links today (1 happy path + 4 rejections)
        const r = await addLink(owner, b, `https://soundcloud.com/e2e-user/capped-${run}`)
        expect(r.status).toBe(429)
        expect(await r.json()).toEqual({ error: 'sc_daily_cap' })
        expect(r.headers.get('retry-after')).toBeTruthy()
      } finally {
        await ownerSql()`UPDATE settings SET value = ${ownerSql().json(prev as never)} WHERE key = 'caps'`
      }
    })

    it('someone else cannot add a link to this batch', async () => {
      const other = await loginOk({ id: newId() })
      const r = await addLink(other, b, `https://soundcloud.com/e2e-user/x-${randomUUID().slice(0, 8)}`)
      expect(r.status).toBe(404)
    })
  })
})
