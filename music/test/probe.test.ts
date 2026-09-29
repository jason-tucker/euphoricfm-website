// Probe + finalize, run in-process in the test image (same ffmpeg / rsvg /
// bundled music-metadata child as the probe image). The e2e suite repeats the
// hostile cases through the real network-less container.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import NodeID3 from 'node-id3'
import { beforeAll, describe, expect, it } from 'vitest'
import { runArt, runArtRelease } from '@/probe/art'
import { runFinalize } from '@/probe/finalize'
import { ContainmentBreach, processOne } from '@/probe/main'
import { findStrays, findStraysAfterGrace, snapshotBaseline } from '@/probe/containment'
import { limitedArgv, PRLIMIT, runLimited, TIMEOUT } from '@/probe/exec'
import { ffprobeArgs, judgeFfprobe, runProbe } from '@/probe/probe'
import { scanId3 } from '@/probe/id3scan'
import { checkMp3Magic } from '@/probe/magic'
import { dimsAcceptable, ffmpegCoverArgs, imageDims, reencodeCover, sniffImage } from '@/probe/cover'
import { readSpoolResult, writeSpoolRequest } from '@/server/spool/protocol'
import { fx, fxBuf } from './helpers/fixtures'
import { waitFor } from './helpers/wait'

const MM = resolve('dist/probe/mm-child.mjs')
let root: string
let dirs: { uploads: string; work: string; final: string; mmChild: string; spool: string; artIn: string; art: string; fetch: string }

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
  dirs = { uploads: join(root, 'uploads'), work: join(root, 'work'), final: join(root, 'final'), mmChild: MM, spool: join(root, 'spool'), artIn: join(root, 'art-in'), art: join(root, 'art'), fetch: join(root, 'fetch') }
  for (const d of [dirs.uploads, dirs.work, dirs.final, dirs.artIn, dirs.art, ...['in-web', 'in-worker', 'out', 'claimed'].map((x) => join(dirs.spool, x))]) mkdirSync(d, { recursive: true })
  expect(existsSync(MM)).toBe(true)
})

describe('probe: accepts real mp3', () => {
  it('extracts tags, re-encodes a PNG cover to a ≤1000 px JPEG, reports sha256', async () => {
    const r = await probe('tagged-png.mp3')
    expect(r).toMatchObject({ ok: true, type: 'probe', source: 'in-web', bitrate: 128000, tags: { title: 'Test Title', artist: 'Test Artist', album: 'Test Album', genre: 'Pop' } })
    if (!r.ok || r.type !== 'probe') throw new Error('not ok')
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
    expect(judgeFfprobe(ok)).toEqual({ durationS: 60, bitrate: 192000, sampleRate: null, channels: null })
    expect(() => judgeFfprobe({ ...ok, format: { ...ok.format, format_name: 'hls' } })).toThrow('not_mp3')
    // v0.3.5: 24 min (the longest song that fits at 192 kbps), was 20 min
    expect(judgeFfprobe({ ...ok, format: { ...ok.format, duration: '1440' } }).durationS).toBe(1440)
    expect(() => judgeFfprobe({ ...ok, format: { ...ok.format, duration: '1441' } })).toThrow('too_long')
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
    if (!r.ok || r.type !== 'probe') throw new Error('probe failed')
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
    if (!p.ok || p.type !== 'probe') throw new Error()
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

// Killed processes are reaped asynchronously: poll (bounded) instead of a
// fixed 200 ms sleep, which was both slow and a guess on a busy runner.
const reaped = (pid: number) => waitFor(async () => !alive(pid), 3000, 20)

function alive(pid: number): boolean {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3)
    return state !== 'Z' && state !== 'X'
  } catch {
    return false
  }
}

describe('probe exec: limits without a shell', () => {
  it('builds a plain argv (prlimit → timeout → tool), never a shell command string', () => {
    const argv = limitedArgv('ffprobe', ['-i', 'a b; $(id)'], 1024, 20.7)
    expect(argv).toEqual(['--as=1048576', '--core=0', '--', TIMEOUT, '-s', 'KILL', '-k', '1', '20', 'ffprobe', '-i', 'a b; $(id)'])
    expect(PRLIMIT).toBe('/usr/bin/prlimit')
    expect(() => limitedArgv('x', [], Number.NaN, 1)).toThrow()
  })

  it('the child runs with RLIMIT_AS = vmemKb KiB (soft and hard) and no core dumps', async () => {
    const r = await runLimited('cat', ['/proc/self/limits'], { timeoutS: 5, vmemKb: 200 * 1024 })
    expect(r.code).toBe(0)
    const lim = r.stdout.toString()
    expect(lim).toMatch(/^Max address space\s+209715200\s+209715200\s+bytes/m)
    expect(lim).toMatch(/^Max core file size\s+0\s+0\s+bytes/m)
  })

  it('the address-space limit is enforced on the tool', async () => {
    // node cannot even start its heap in 64 MiB of address space
    const r = await runLimited('node', ['-e', 'console.log("started")'], { timeoutS: 10, vmemKb: 64 * 1024 })
    expect(r.code).not.toBe(0)
    expect(r.stdout.toString()).not.toContain('started')
  })

  it('arguments with shell syntax reach the tool verbatim and are never executed', async () => {
    const marker = join(root, `pwned-${randomUUID()}`)
    const hostile = [`$(touch ${marker})`, `\`touch ${marker}\``, `; touch ${marker}`, `"$@" '|' && touch ${marker}`, '*', '\n']
    const r = await runLimited('printf', ['[%s]', ...hostile], { timeoutS: 5, vmemKb: 1 << 20 })
    expect(r.code).toBe(0)
    expect(r.stdout.toString()).toBe(hostile.map((h) => `[${h}]`).join(''))
    expect(existsSync(marker)).toBe(false)
  })

  it('timeouts still apply through prlimit (exit via SIGKILL, reported as timedOut)', async () => {
    const t0 = Date.now()
    const r = await runLimited('sleep', ['30'], { timeoutS: 1, vmemKb: 1 << 20 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(8000)
  })
})

describe('probe containment: parser children cannot outlive their job', () => {
  it('a timeout kills the whole process group, grandchildren included', async () => {
    const t0 = Date.now()
    const r = await runLimited('sh', ['-c', 'sleep 30 & echo $!; sleep 60'], { timeoutS: 1, vmemKb: 1 << 20 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(8000)
    const grandchild = Number(r.stdout.toString().trim())
    expect(grandchild).toBeGreaterThan(1)
    await reaped(grandchild)
  })

  it('a background grandchild left behind by a child that exits normally dies with the job (and does not hold the call open)', async () => {
    const t0 = Date.now()
    const r = await runLimited('sh', ['-c', 'sleep 30 & echo $!'], { timeoutS: 20, vmemKb: 1 << 20 })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.code).toBe(0)
    const grandchild = Number(r.stdout.toString().trim())
    await reaped(grandchild)
  })

  it('a process that escapes the group (setsid) is found by the post-job check; processOne refuses the result and throws', async () => {
    const baseline = await snapshotBaseline()
    await runLimited('sh', ['-c', 'setsid sleep 45 </dev/null >/dev/null 2>&1 & sleep 1'], { timeoutS: 5, vmemKb: 1 << 20 })
    // the setsid'd sleep shows up in the process table (bounded poll, not a fixed wait)
    const strays = await waitFor(async () => {
      const s = (await findStrays(baseline)).filter((p) => p.cmd === 'sleep')
      return s.length ? s : null
    }, 2000, 25)
    expect(strays.length).toBe(1)
    const id = randomUUID()
    await writeSpoolRequest(join(dirs.spool, 'in-worker'), { v: 1, id, type: 'probe', upload: 'c'.repeat(32), expectedSize: 5 })
    await expect(processOne('in-worker', id, { ...dirs, spool: dirs.spool }, async () => strays)).rejects.toBeInstanceOf(ContainmentBreach)
    expect(await readSpoolResult(join(dirs.spool, 'out'), id)).toMatchObject({ ok: false, error: 'containment_breach' })
    await reaped(strays[0]!.pid) // killed
  })
})

// ---------------------------------------------------- cover decode bounds ---

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]) // CRC not checked by the header parser
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function ihdr(w: number, h: number): Buffer {
  const d = Buffer.alloc(13)
  d.writeUInt32BE(w, 0)
  d.writeUInt32BE(h, 4)
  d[8] = 8
  d[9] = 6
  return pngChunk('IHDR', d)
}
function jpegSeg(marker: number, payload: Buffer): Buffer {
  const h = Buffer.from([0xff, marker, 0, 0])
  h.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([h, payload])
}
function sof(w: number, h: number, marker = 0xc0): Buffer {
  const p = Buffer.alloc(15)
  p[0] = 8
  p.writeUInt16BE(h, 1)
  p.writeUInt16BE(w, 3)
  p[5] = 3
  return jpegSeg(marker, p)
}
const SOI = Buffer.from([0xff, 0xd8])
const SOS = jpegSeg(0xda, Buffer.alloc(10))

describe('cover decode bounds (crafted headers)', () => {
  it('PNG: IHDR must be the first chunk; a tEXt chunk carrying fake small dims in front is refused', () => {
    const text = Buffer.alloc(13)
    text.writeUInt32BE(100, 0)
    text.writeUInt32BE(100, 4)
    const fake = Buffer.concat([PNG_SIG, pngChunk('tEXt', text), ihdr(12000, 12000)])
    expect(fake.readUInt32BE(16)).toBe(100) // what the old parser read
    expect(imageDims(fake, 'png')).toBeNull()
    expect(imageDims(Buffer.concat([PNG_SIG, ihdr(3000, 2000)]), 'png')).toEqual({ w: 3000, h: 2000 })
    expect(imageDims(Buffer.concat([PNG_SIG, ihdr(3000, 2000)]).subarray(0, 24), 'png')).toBeNull() // truncated
  })

  it('JPEG: exactly one SOF before SOS; truncated / hierarchical / malformed headers are unreadable', () => {
    expect(imageDims(Buffer.concat([SOI, jpegSeg(0xe0, Buffer.alloc(14)), sof(640, 480), SOS]), 'jpeg')).toEqual({ w: 640, h: 480 })
    expect(imageDims(Buffer.concat([SOI, sof(100, 100), sof(12000, 12000, 0xc2), SOS]), 'jpeg')).toBeNull()
    expect(imageDims(Buffer.concat([SOI, sof(100, 100)]), 'jpeg')).toBeNull() // no SOS: truncated
    expect(imageDims(Buffer.concat([SOI, jpegSeg(0xde, Buffer.alloc(8)), sof(100, 100), SOS]), 'jpeg')).toBeNull() // DHP
    expect(imageDims(Buffer.concat([SOI, Buffer.from([0xff, 0xc0, 0x00, 0x05, 8, 0, 100]), SOS]), 'jpeg')).toBeNull() // SOF too short
    expect(imageDims(Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0xff, 0xff]), sof(100, 100), SOS]), 'jpeg')).toBeNull() // length past the end
  })

  it('WebP: the VP8 key-frame start code and the VP8L signature are required', () => {
    const riff = (chunk: string, body: Buffer) => {
      const h = Buffer.alloc(20)
      h.write('RIFF', 0, 'latin1')
      h.writeUInt32LE(body.length + 12, 4)
      h.write('WEBP', 8, 'latin1')
      h.write(chunk, 12, 'latin1')
      h.writeUInt32LE(body.length, 16)
      return Buffer.concat([h, body])
    }
    const vp8 = Buffer.alloc(12)
    vp8.set([0x9d, 0x01, 0x2a], 3)
    vp8.writeUInt16LE(800, 6)
    vp8.writeUInt16LE(600, 8)
    expect(imageDims(riff('VP8 ', vp8), 'webp')).toEqual({ w: 800, h: 600 })
    const bad = Buffer.from(vp8)
    bad[3] = 0
    expect(imageDims(riff('VP8 ', bad), 'webp')).toBeNull()
    const vp8l = Buffer.alloc(12)
    vp8l[0] = 0x2e // wrong signature
    expect(imageDims(riff('VP8L', vp8l), 'webp')).toBeNull()
  })

  it('the pixel bound is 12 MP; the decoder gets -max_pixels before -i', () => {
    expect(dimsAcceptable({ w: 3464, h: 3464 })).toBe(true)
    expect(dimsAcceptable({ w: 4000, h: 3500 })).toBe(false)
    expect(dimsAcceptable({ w: 8001, h: 10 })).toBe(false)
    expect(dimsAcceptable(null)).toBe(false)
    const a = ffmpegCoverArgs('/w/in', 'png', '/w/out.jpg')
    expect(a.indexOf('-max_pixels')).toBeGreaterThan(-1)
    expect(a.indexOf('-max_pixels')).toBeLessThan(a.indexOf('-i'))
    expect(Number(a[a.indexOf('-max_pixels') + 1])).toBeLessThanOrEqual(13_000_000)
  })

  it('a fake-IHDR PNG cover is dropped before any decoder runs; a real 12 MP PNG decodes within the memory limit', async () => {
    const w = mkdtempSync(join(tmpdir(), 'cov-'))
    const text = Buffer.alloc(13)
    text.writeUInt32BE(100, 0)
    text.writeUInt32BE(100, 4)
    const fake = Buffer.concat([PNG_SIG, pngChunk('tEXt', text), ihdr(12000, 12000), pngChunk('IEND', Buffer.alloc(0))])
    writeFileSync(join(w, 'fake.png'), fake)
    const t0 = Date.now()
    expect(await reencodeCover(join(w, 'fake.png'), fake, w, join(w, 'o1.jpg'))).toBeNull()
    expect(Date.now() - t0).toBeLessThan(500)
    expect(existsSync(join(w, 'o1.jpg'))).toBe(false)
    const { execFileSync } = await import('node:child_process')
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=3440x3440', '-frames:v', '1', join(w, 'big.png')])
    const big = readFileSync(join(w, 'big.png'))
    expect(await reencodeCover(join(w, 'big.png'), big, w, join(w, 'o2.jpg'))).not.toBeNull()
    expect(imageDims(readFileSync(join(w, 'o2.jpg')), 'jpeg')).toEqual({ w: 1000, h: 1000 })
  })
})

describe('probe containment: the busybox timeout watcher is not a false positive', () => {
  it('after an ordinary runLimited job, nothing is left once the grace period passes', async () => {
    const baseline = await snapshotBaseline()
    await runLimited('sleep', ['0.2'], { timeoutS: 5, vmemKb: 1 << 20 })
    const strays = (await findStraysAfterGrace(baseline)).filter((p) => p.cmd === 'timeout' || p.cmd === 'sleep')
    expect(strays).toEqual([])
  })
})

// ------------------------------------------------ standalone album art ---

describe('probe: standalone album art (art contract)', () => {
  async function art(name: string, bytes?: Buffer) {
    const id = randomUUID()
    const data = bytes ?? fxBuf(name)
    writeFileSync(join(dirs.artIn, id), data)
    const r = await runArt({ v: 1, id, type: 'art', expectedSize: data.length }, { artIn: dirs.artIn, art: dirs.art, work: dirs.work })
    return { id, r }
  }

  it('JPEG, PNG and WebP are re-encoded to a ≤1000 px baseline JPEG with its sha256 recorded', async () => {
    for (const name of ['art.jpg', 'art.png', 'art.webp']) {
      const { id, r } = await art(name)
      if (!r.ok || r.type !== 'art') throw new Error(`${name}: ${JSON.stringify(r)}`)
      const jpg = readFileSync(join(dirs.art, id, 'cover.jpg'))
      expect(sniffImage(jpg)).toBe('jpeg')
      expect(r.sha256).toBe(createHash('sha256').update(jpg).digest('hex'))
      expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(1000)
      expect(imageDims(jpg, 'jpeg')).toEqual({ w: r.width, h: r.height })
      expect(jpg.includes(Buffer.from('Lavf'))).toBe(false) // no encoder/metadata comment carried over
    }
  })

  it('SVG, GIF, oversized, truncated and fake-header images are refused before any decoder runs', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
    expect((await art('', svg)).r).toMatchObject({ ok: false, error: 'unsupported_image_type' })
    expect((await art('art.gif')).r).toMatchObject({ ok: false, error: 'unsupported_image_type' })
    expect((await art('', Buffer.concat([PNG_SIG, ihdr(5000, 5000), pngChunk('IEND', Buffer.alloc(0))]))).r).toMatchObject({ ok: false, error: 'image_too_large' })
    const p = fxBuf('art.png')
    expect((await art('', p.subarray(0, p.length - 100))).r).toMatchObject({ ok: false, error: 'image_truncated' })
    expect((await art('', fxBuf('art.png').subarray(0, 20))).r).toMatchObject({ ok: false, error: 'unreadable_image_header' })
    const text = Buffer.alloc(13)
    text.writeUInt32BE(100, 0)
    text.writeUInt32BE(100, 4)
    expect((await art('', Buffer.concat([PNG_SIG, pngChunk('tEXt', text), ihdr(12000, 12000)]))).r).toMatchObject({ ok: false, error: 'unreadable_image_header' })
    const t = fxBuf('art.jpg')
    expect((await art('', t.subarray(0, Math.floor(t.length / 2)))).r).toMatchObject({ ok: false, error: 'image_truncated' })
  })

  it('art_release deletes the JPEG; an art id is never re-used', async () => {
    const { id } = await art('art.jpg')
    const again = await runArt({ v: 1, id, type: 'art', expectedSize: fxBuf('art.jpg').length }, { artIn: dirs.artIn, art: dirs.art, work: dirs.work })
    expect(again).toMatchObject({ ok: false, error: 'art_exists' })
    await runArtRelease({ v: 1, id: randomUUID(), type: 'art_release', artId: id }, { artIn: dirs.artIn, art: dirs.art, work: dirs.work })
    expect(existsSync(join(dirs.art, id))).toBe(false)
  })

  it('an art request is accepted only from in-web', async () => {
    const id = randomUUID()
    writeFileSync(join(dirs.artIn, id), fxBuf('art.jpg'))
    await writeSpoolRequest(join(dirs.spool, 'in-worker'), { v: 1, id, type: 'art', expectedSize: fxBuf('art.jpg').length })
    await processOne('in-worker', id, { ...dirs, spool: dirs.spool })
    expect(await readSpoolResult(join(dirs.spool, 'out'), id)).toMatchObject({ ok: false, error: 'type_not_allowed_in_inbox' })
  })
})
