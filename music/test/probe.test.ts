// Probe + finalize, run in-process in the test image (same ffmpeg / rsvg /
// bundled music-metadata child as the probe image). The e2e suite repeats the
// hostile cases through the real network-less container.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import NodeID3 from 'node-id3'
import { beforeAll, describe, expect, it } from 'vitest'
import { runFinalize } from '@/probe/finalize'
import { ContainmentBreach, processOne } from '@/probe/main'
import { findStrays, snapshotBaseline } from '@/probe/containment'
import { runLimited } from '@/probe/exec'
import { ffprobeArgs, judgeFfprobe, runProbe } from '@/probe/probe'
import { scanId3 } from '@/probe/id3scan'
import { checkMp3Magic } from '@/probe/magic'
import { imageDims, sniffImage } from '@/probe/cover'
import { readSpoolResult, writeSpoolRequest } from '@/server/spool/protocol'
import { fx, fxBuf } from './helpers/fixtures'

const MM = resolve('dist/probe/mm-child.mjs')
let root: string
let dirs: { uploads: string; work: string; final: string; mmChild: string; spool: string }

function stage(name: string): { upload: string; size: number } {
  const upload = randomUUID().replace(/-/g, '')
  copyFileSync(fx(name), join(dirs.uploads, upload))
  return { upload, size: readFileSync(fx(name)).length }
}

async function probe(name: string) {
  const s = stage(name)
  return { ...(await runProbe({ v: 1, id: randomUUID(), type: 'probe', upload: s.upload, expectedSize: s.size }, dirs)), upload: s.upload }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'probe-'))
  dirs = { uploads: join(root, 'uploads'), work: join(root, 'work'), final: join(root, 'final'), mmChild: MM, spool: join(root, 'spool') }
  for (const d of [dirs.uploads, dirs.work, dirs.final, ...['in-web', 'in-worker', 'out', 'claimed'].map((x) => join(dirs.spool, x))]) mkdirSync(d, { recursive: true })
  expect(existsSync(MM)).toBe(true)
})

describe('probe: accepts real mp3', () => {
  it('extracts tags, re-encodes a PNG cover to a ≤1000 px JPEG, reports sha256', async () => {
    const r = await probe('tagged-png.mp3')
    expect(r).toMatchObject({ ok: true, type: 'probe', source: 'in-web', bitrate: 128000, tags: { title: 'Test Title', artist: 'Test Artist', album: 'Test Album', genre: 'Pop' } })
    if (!r.ok || !('sha256' in r)) throw new Error('not ok')
    expect(r.sha256).toBe(createHash('sha256').update(fxBuf('tagged-png.mp3')).digest('hex'))
    expect(r.durationS).toBeGreaterThanOrEqual(34)
    const jpg = readFileSync(join(dirs.uploads, r.cover!.file))
    expect(jpg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(Math.max(r.cover!.width, r.cover!.height)).toBe(1000) // 1200x900 → 1000x750
    expect(r.cover!.sha256).toBe(createHash('sha256').update(jpg).digest('hex'))
  })

  it('an SVG cover (with <script> and an external href) becomes a plain JPEG', async () => {
    const r = await probe('svg-cover.mp3')
    if (!r.ok || !('cover' in r)) throw new Error(JSON.stringify(r))
    expect(r.cover).not.toBeNull()
    const jpg = readFileSync(join(dirs.uploads, r.cover!.file))
    expect(sniffImage(jpg)).toBe('jpeg')
    expect(jpg.includes(Buffer.from('<script'))).toBe(false)
    expect(jpg.includes(Buffer.from('svg'))).toBe(false)
  })

  it('a cover declaring 60000x60000 is dropped before any decoder runs; the song survives', async () => {
    const r = await probe('dimbomb-cover.mp3')
    expect(r).toMatchObject({ ok: true, cover: null, flags: ['cover_dropped'] })
  })
})

describe('probe: refuses hostile or unfit files', () => {
  const cases: [string, string][] = [
    ['hls.mp3', 'not_mp3'], // HLS playlist named .mp3: fails the magic check
    ['hls-id3.mp3', 'not_mp3'], // …even behind a valid ID3 tag
    ['hls-fakeframe.mp3', 'not_mp3'], // …even behind one fake MPEG frame header
    ['html.mp3', 'not_mp3'],
    ['zlib-bomb.mp3', 'id3_compressed_frame'], // 64 MB of zeros in a compressed ID3v2.4 frame
    ['huge-apic.mp3', 'id3_too_large'], // 6 MB APIC → tag > 5 MB
    ['lowbr.mp3', 'bitrate_too_low'],
    ['short.mp3', 'too_short'],
  ]
  for (const [name, code] of cases) {
    it(`${name} → ${code}`, async () => {
      expect(await probe(name)).toMatchObject({ ok: false, error: code })
    })
  }

  it('refuses a size that differs from the tus Upload-Length', async () => {
    const s = stage('raw35.mp3')
    const r = await runProbe({ v: 1, id: randomUUID(), type: 'probe', upload: s.upload, expectedSize: s.size + 1 }, dirs)
    expect(r).toMatchObject({ ok: false, error: 'input_size_mismatch' })
  })

  it('never follows a symlink planted in the uploads dir', async () => {
    const upload = randomUUID().replace(/-/g, '')
    symlinkSync('/etc/passwd', join(dirs.uploads, upload))
    const r = await runProbe({ v: 1, id: randomUUID(), type: 'probe', upload, expectedSize: 10 }, dirs)
    expect(r).toMatchObject({ ok: false, error: 'input_missing' })
  })

  it('ffprobe is always forced to the mp3 demuxer with file/pipe protocols only', () => {
    const a = ffprobeArgs('/x/in.mp3')
    expect(a.join(' ')).toContain('-protocol_whitelist file,pipe -f mp3 -threads 1')
    expect(a.at(-1)).toBe('file:/x/in.mp3')
  })

  it('judge: container and stream rules', () => {
    const ok = { format: { format_name: 'mp3', duration: '60', bit_rate: '192000' }, streams: [{ codec_type: 'audio', codec_name: 'mp3', bit_rate: '192000' }] }
    expect(judgeFfprobe(ok)).toEqual({ durationS: 60, bitrate: 192000 })
    expect(() => judgeFfprobe({ ...ok, format: { ...ok.format, format_name: 'hls' } })).toThrow('not_mp3')
    expect(() => judgeFfprobe({ ...ok, format: { ...ok.format, duration: '1201' } })).toThrow('too_long')
    expect(() => judgeFfprobe({ ...ok, streams: [...ok.streams, { codec_type: 'data' }] })).toThrow('unexpected_streams')
    expect(() => judgeFfprobe({ ...ok, streams: [...ok.streams, ok.streams[0]] })).toThrow('not_single_mp3_stream')
  })

  it('ID3 scanner: compressed / encrypted / overflowing frames', () => {
    const tagOf = (major: number, frame: Buffer) => {
      const body = frame
      const h = Buffer.from([0x49, 0x44, 0x33, major, 0, 0, 0, 0, 0, 0])
      h[9] = body.length & 0x7f
      h[8] = (body.length >> 7) & 0x7f
      return Buffer.concat([h, body])
    }
    const f3 = (flags: number, size = 4) => Buffer.concat([Buffer.from('TIT2'), Buffer.from([0, 0, 0, size, 0, flags]), Buffer.alloc(size)])
    expect(scanId3(tagOf(3, f3(0x80)), 24)).toEqual({ ok: false, reason: 'id3_compressed_frame' })
    expect(scanId3(tagOf(3, f3(0x40)), 24)).toEqual({ ok: false, reason: 'id3_encrypted_frame' })
    expect(scanId3(tagOf(3, f3(0x00, 100)), 24)).toEqual({ ok: false, reason: 'id3_frame_overflow' })
    expect(scanId3(tagOf(3, f3(0x00)), 24)).toEqual({ ok: true, present: true, frames: 1 })
    expect(scanId3(Buffer.alloc(10), 6 * 1024 * 1024)).toEqual({ ok: false, reason: 'id3_too_large' })
  })

  it('magic: mp3 behind ID3 passes; other formats fail', async () => {
    const b = fxBuf('tagged-png.mp3')
    const read = async (o: number, l: number) => b.subarray(o, o + l)
    expect(await checkMp3Magic(read, b.length)).toMatchObject({ ok: true })
    const png = fxBuf('cover.png')
    expect(await checkMp3Magic(async (o, l) => png.subarray(o, o + l), png.length)).toMatchObject({ ok: false })
  })

  it('image dimension parsing', () => {
    expect(imageDims(fxBuf('cover.png'), 'png')).toEqual({ w: 1200, h: 900 })
  })
})

describe('finalize', () => {
  async function probed(name: string) {
    const r = await probe(name)
    if (!r.ok || !('sha256' in r)) throw new Error('probe failed')
    return r
  }

  it('verifies the approved sha, strips all tags, writes a clean ID3 with the JPEG', async () => {
    const p = await probed('tagged-png.mp3')
    const id = randomUUID()
    const r = await runFinalize(
      { v: 1, id, type: 'finalize', upload: p.upload, approvedSha256: p.sha256, tags: { title: 'Final T', artist: 'Final A', album: 'Final Al', genre: 'Dance' }, cover: { file: p.cover!.file, sha256: p.cover!.sha256 } },
      dirs,
    )
    if (!r.ok || !('finalSha256' in r)) throw new Error(JSON.stringify(r))
    const out = readFileSync(join(dirs.final, r.file))
    expect(createHash('sha256').update(out).digest('hex')).toBe(r.finalSha256)
    const tags = NodeID3.read(out)
    expect(tags).toMatchObject({ title: 'Final T', artist: 'Final A', album: 'Final Al', genre: 'Dance' })
    expect((tags.image as { mime: string }).mime).toBe('image/jpeg')
    // original tag text is gone
    expect(out.includes(Buffer.from('Test Title'))).toBe(false)
  })

  it('refuses when the staged bytes no longer match approved_sha256', async () => {
    const p = await probed('tagged-png.mp3')
    writeFileSync(join(dirs.uploads, p.upload), Buffer.concat([readFileSync(join(dirs.uploads, p.upload)), Buffer.from([0])]))
    const r = await runFinalize({ v: 1, id: randomUUID(), type: 'finalize', upload: p.upload, approvedSha256: p.sha256, tags: { title: 'a', artist: 'b', album: '', genre: '' }, cover: null }, dirs)
    expect(r).toMatchObject({ ok: false, error: 'sha_mismatch' })
  })

  it('refuses a cover whose sha changed', async () => {
    const p = await probed('tagged-png.mp3')
    const r = await runFinalize({ v: 1, id: randomUUID(), type: 'finalize', upload: p.upload, approvedSha256: p.sha256, tags: { title: 'a', artist: 'b', album: '', genre: '' }, cover: { file: p.cover!.file, sha256: '0'.repeat(64) } }, dirs)
    expect(r).toMatchObject({ ok: false, error: 'cover_sha_mismatch' })
  })
})

describe('probe inbox rules', () => {
  it('a finalize request found in in-web is refused, not executed', async () => {
    const p = await probe('raw35.mp3')
    if (!p.ok || !('sha256' in p)) throw new Error()
    const id = randomUUID()
    await writeSpoolRequest(join(dirs.spool, 'in-web'), { v: 1, id, type: 'finalize', upload: p.upload, approvedSha256: p.sha256, tags: { title: 'a', artist: 'b', album: '', genre: '' }, cover: null })
    await processOne('in-web', id, { ...dirs, spool: dirs.spool })
    expect(await readSpoolResult(join(dirs.spool, 'out'), id)).toMatchObject({ ok: false, error: 'type_not_allowed_in_inbox', source: 'in-web', type: 'finalize' })
    expect(existsSync(join(dirs.final, `${id}.mp3`))).toBe(false)
  })

  it('a probe request found in in-worker is refused', async () => {
    const id = randomUUID()
    await writeSpoolRequest(join(dirs.spool, 'in-worker'), { v: 1, id, type: 'probe', upload: 'a'.repeat(32), expectedSize: 5 })
    await processOne('in-worker', id, { ...dirs, spool: dirs.spool })
    expect(await readSpoolResult(join(dirs.spool, 'out'), id)).toMatchObject({ ok: false, error: 'type_not_allowed_in_inbox' })
  })

  it('a request file that is a symlink is not followed; results never overwrite', async () => {
    const id = randomUUID()
    symlinkSync('/etc/hostname', join(dirs.spool, 'in-web', `${id}.json`))
    await processOne('in-web', id, { ...dirs, spool: dirs.spool })
    expect(await readSpoolResult(join(dirs.spool, 'out'), id)).toMatchObject({ ok: false, error: 'bad_request_file' })
    await writeSpoolRequest(join(dirs.spool, 'in-web'), { v: 1, id, type: 'probe', upload: 'b'.repeat(32), expectedSize: 5 })
    await processOne('in-web', id, { ...dirs, spool: dirs.spool })
    expect(await readSpoolResult(join(dirs.spool, 'out'), id)).toMatchObject({ error: 'bad_request_file' }) // first result kept
  })
})

// ------------------------------------------------ probe containment ---

function alive(pid: number): boolean {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3)
    return state !== 'Z' && state !== 'X'
  } catch {
    return false
  }
}

describe('probe containment: parser children cannot outlive their job', () => {
  it('a timeout kills the whole process group, grandchildren included', async () => {
    const t0 = Date.now()
    const r = await runLimited('sh', ['-c', 'sleep 30 & echo $!; sleep 60'], { timeoutS: 1, vmemKb: 1 << 20 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(8000)
    const grandchild = Number(r.stdout.toString().trim())
    expect(grandchild).toBeGreaterThan(1)
    await new Promise((res) => setTimeout(res, 200))
    expect(alive(grandchild)).toBe(false)
  })

  it('a background grandchild left behind by a child that exits normally dies with the job (and does not hold the call open)', async () => {
    const t0 = Date.now()
    const r = await runLimited('sh', ['-c', 'sleep 30 & echo $!'], { timeoutS: 20, vmemKb: 1 << 20 })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.code).toBe(0)
    const grandchild = Number(r.stdout.toString().trim())
    await new Promise((res) => setTimeout(res, 200))
    expect(alive(grandchild)).toBe(false)
  })

  it('a process that escapes the group (setsid) is found by the post-job check; processOne refuses the result and throws', async () => {
    const baseline = await snapshotBaseline()
    await runLimited('sh', ['-c', 'setsid sleep 45 </dev/null >/dev/null 2>&1 & sleep 1'], { timeoutS: 5, vmemKb: 1 << 20 })
    await new Promise((res) => setTimeout(res, 200))
    const strays = (await findStrays(baseline)).filter((p) => p.cmd === 'sleep')
    expect(strays.length).toBe(1)
    const id = randomUUID()
    await writeSpoolRequest(join(dirs.spool, 'in-worker'), { v: 1, id, type: 'probe', upload: 'c'.repeat(32), expectedSize: 5 })
    await expect(processOne('in-worker', id, { ...dirs, spool: dirs.spool }, async () => strays)).rejects.toBeInstanceOf(ContainmentBreach)
    expect(await readSpoolResult(join(dirs.spool, 'out'), id)).toMatchObject({ ok: false, error: 'containment_breach' })
    await new Promise((res) => setTimeout(res, 200))
    expect(alive(strays[0]!.pid)).toBe(false) // killed
  })
})
