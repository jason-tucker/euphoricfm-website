// v0.3.0 WAV inputs, probe side, run in-process in the test image (same
// ffmpeg / ffprobe / prlimit / bundled music-metadata child as the probe
// image). Accepted WAVs are converted to a CBR MP3 (320 kbps when it fits,
// v0.3.5: else the fit.ts ladder; tests in fit-probe.test.ts) that replaces the
// WAV under the upload id; everything else is refused with a reason code,
// and a refused upload's bytes are deleted (`released`).
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import NodeID3 from 'node-id3'
import { beforeAll, describe, expect, it } from 'vitest'
import { limitedArgv, NICE, TIMEOUT } from '@/probe/exec'
import { runFinalize } from '@/probe/finalize'
import { checkMp3Magic } from '@/probe/magic'
import { clearStaleWork, recoverInterrupted } from '@/probe/main'
import { runProbe } from '@/probe/probe'
import { reader } from '@/probe/files'
import { CONVERT_NICE, CONVERT_TIMEOUT_S, convertArgs, judgeWavFfprobe, scanWav, sniffWav, targetRate, wavFfprobeArgs } from '@/probe/wav'
import { MAX_DURATION_S } from '@/lib/fit'
import { MAX_UPLOAD_BYTES, MAX_WAV_UPLOAD_BYTES, probeRequest, readSpoolResult, spoolResult } from '@/server/spool/protocol'
import { fx, fxBuf } from './helpers/fixtures'
import { apicV3, frameV3, frameV4, tag, textV3, zlibBombFrame } from './helpers/id3'
import { chunk, fmtBody, infoList, riff, simpleWav, sinePcm16 } from './helpers/wav'

const MM = resolve('dist/probe/mm-child.mjs')
let root: string
let dirs: { uploads: string; work: string; mmChild: string }

function stageBuf(data: Buffer): { upload: string; size: number } {
  const upload = randomUUID().replace(/-/g, '')
  writeFileSync(join(dirs.uploads, upload), data)
  return { upload, size: data.length }
}

async function probeBuf(data: Buffer, extra: { maxWavBytes?: number } = {}) {
  const s = stageBuf(data)
  const r = await runProbe({ v: 1, id: randomUUID(), type: 'probe', upload: s.upload, expectedSize: s.size, ...extra }, dirs)
  expect(spoolResult.safeParse(r).success).toBe(true) // the worker can read what the probe wrote
  return { r, upload: s.upload, path: join(dirs.uploads, s.upload) }
}
const probeFx = (name: string, extra: { maxWavBytes?: number } = {}) => probeBuf(fxBuf(name), extra)

function ffprobeJson(file: string): { streams: { codec_name: string; sample_rate: string; channels: number; bit_rate: string }[]; format: { duration: string; format_name: string } } {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString())
}

const PNG = () => fxBuf('cover.png')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wavprobe-'))
  dirs = { uploads: join(root, 'uploads'), work: join(root, 'work'), mmChild: MM }
  for (const d of [dirs.uploads, dirs.work, join(root, 'final')]) mkdirSync(d, { recursive: true })
  expect(existsSync(MM)).toBe(true)
})

describe('WAV → 320 kbps MP3 (accepted inputs)', () => {
  // [fixture, source rate, source channels, expected MP3 rate, expected MP3 channels]
  const cases: [string, number, number, number, number][] = [
    ['s16-44k-stereo.wav', 44100, 2, 44100, 2],
    ['s24-48k-stereo.wav', 48000, 2, 48000, 2], // WAVE_FORMAT_EXTENSIBLE (24-bit)
    ['s24-96k-stereo.wav', 96000, 2, 48000, 2], // multiple of 48k → 48k
    ['s16-88k-stereo.wav', 88200, 2, 44100, 2], // other → 44.1k
    ['s16-22k-mono.wav', 22050, 1, 44100, 1], // mono stays mono
    ['s32-44k-stereo.wav', 44100, 2, 44100, 2],
    ['u8-44k-mono.wav', 44100, 1, 44100, 1],
    ['f32-48k-stereo.wav', 48000, 2, 48000, 2],
    ['f64-44k-stereo.wav', 44100, 2, 44100, 2],
    ['s16-48k-5.1.wav', 48000, 6, 48000, 2], // 5.1 → stereo downmix
  ]
  for (const [name, , , rate, ch] of cases) {
    it(`${name} → CBR 320k MP3, ${rate} Hz, ${ch} ch; the MP3 replaces the WAV`, async () => {
      const { r, path } = await probeFx(name)
      if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
      expect(r).toMatchObject({ inputFormat: 'wav', bitrate: 320000, transcodeKbps: 320, flags: ['converted_from_wav'] })
      expect(r.durationS).toBeGreaterThanOrEqual(34.9)
      expect(r.durationS).toBeLessThanOrEqual(35.2)
      const mp3 = readFileSync(path)
      expect(mp3.toString('latin1', 0, 4)).not.toBe('RIFF') // the WAV is gone
      expect(r.sha256).toBe(createHash('sha256').update(mp3).digest('hex'))
      expect(r.size).toBe(mp3.length)
      expect((await checkMp3Magic(reader(path), mp3.length)).ok).toBe(true)
      const j = ffprobeJson(path)
      expect(j.format.format_name).toBe('mp3')
      expect(j.streams).toHaveLength(1)
      expect(j.streams[0]).toMatchObject({ codec_name: 'mp3', sample_rate: String(rate), channels: ch, bit_rate: '320000' })
      expect(mp3.subarray(0, 3).toString('latin1')).not.toBe('ID3') // no tags: finalize writes them
    })
  }

  it('prefills title/artist/album/genre/year from LIST/INFO (through clipTag)', async () => {
    const { r } = await probeFx('s16-44k-stereo.wav')
    expect(r).toMatchObject({ ok: true, tags: { title: 'Wav Title', artist: 'Wav Artist', album: 'Wav Album', genre: 'House', year: '2024' }, cover: null })
  })

  it("an 'id3 ' chunk with APIC: tags prefilled, the cover takes the hardened re-encode path; hostile characters are cleaned", async () => {
    const id3 = tag(3, [
      frameV3('TIT2', textV3('Id3 Title\u0007 bell')),
      frameV3('TPE1', textV3('Id3 Artist')),
      frameV3('TALB', textV3('Id3 Album')),
      frameV3('TCON', textV3('Techno')),
      frameV3('APIC', apicV3('image/png', PNG())),
    ])
    const { r, upload } = await probeBuf(simpleWav({ after: [chunk('id3 ', id3)] }))
    if (!r.ok || r.type !== 'probe') throw new Error(JSON.stringify(r))
    expect(r.tags).toMatchObject({ title: 'Id3 Title  bell', artist: 'Id3 Artist', album: 'Id3 Album', genre: 'Techno' })
    expect(r.cover).not.toBeNull()
    const jpg = readFileSync(join(dirs.uploads, r.cover!.file))
    expect(jpg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(Math.max(r.cover!.width, r.cover!.height)).toBe(1000) // 1200x900 PNG → 1000x750 JPEG

    // finalize (unchanged) takes the converted MP3 + the cover → ID3 + APIC
    const fin = await runFinalize(
      { v: 1, id: randomUUID(), type: 'finalize', upload, approvedSha256: r.sha256, tags: { title: 'T', artist: 'A', album: 'Al', genre: 'G' }, cover: { file: r.cover!.file, sha256: r.cover!.sha256 } },
      { uploads: dirs.uploads, work: dirs.work, final: join(root, 'final') },
    )
    if (!fin.ok || fin.type !== 'finalize') throw new Error(JSON.stringify(fin))
    const out = join(root, 'final', fin.file)
    const t = NodeID3.read(out)
    expect(t).toMatchObject({ title: 'T', artist: 'A', album: 'Al', genre: 'G' })
    expect((t.image as { imageBuffer: Buffer }).imageBuffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(ffprobeJson(out).streams.find((s) => s.codec_name === 'mp3')).toMatchObject({ bit_rate: '320000' })
  })

  it('a WAV over 35 MB (MP3 cap) is accepted; the converted MP3 is ≤ 35 MB', async () => {
    const { r } = await probeFx('big-44mb.wav')
    if (!r.ok || r.type !== 'probe' || !('tags' in r)) throw new Error(JSON.stringify(r))
    expect(fxBuf('big-44mb.wav').length).toBeGreaterThan(MAX_UPLOAD_BYTES)
    expect(r).toMatchObject({ inputFormat: 'wav', bitrate: 320000 })
    expect(r.size).toBeLessThanOrEqual(MAX_UPLOAD_BYTES)
    expect(r.tags).toMatchObject({ title: 'Wav Title', artist: 'Wav Artist' })
  }, 120_000)

  it('plain float, EXTENSIBLE PCM and plain PCM headers parse as the header walk expects', async () => {
    const f32 = await scanWav(reader(fx('f32-48k-stereo.wav')), fxBuf('f32-48k-stereo.wav').length)
    expect(f32.fmt).toMatchObject({ formatTag: 3, extensible: false, channels: 2, sampleRate: 48000, bitsPerSample: 32 })
    const s24 = await scanWav(reader(fx('s24-48k-stereo.wav')), fxBuf('s24-48k-stereo.wav').length)
    expect(s24.fmt).toMatchObject({ formatTag: 1, extensible: true, bitsPerSample: 24 })
    const s16 = await scanWav(reader(fx('s16-44k-stereo.wav')), fxBuf('s16-44k-stereo.wav').length)
    expect(s16.fmt).toMatchObject({ formatTag: 1, extensible: false })
    expect(s16.chunks).toEqual(['fmt ', 'LIST', 'data'])
  })

  it('hand-built IEEE-float WAVs (plain tag 3, and WAVE_FORMAT_EXTENSIBLE with the float GUID) are accepted', async () => {
    const n = 35 * 8000
    const f = Buffer.alloc(n * 4)
    for (let i = 0; i < n; i++) f.writeFloatLE(Math.sin(i / 10) * 0.3, i * 4)
    const plain = await probeBuf(riff([chunk('fmt ', fmtBody({ tag: 3, channels: 1, rate: 8000, bits: 32 })), chunk('data', f)]))
    expect(plain.r).toMatchObject({ ok: true, inputFormat: 'wav' })
    const ext = await probeBuf(riff([chunk('fmt ', fmtBody({ extensible: { subTag: 3 }, channels: 1, rate: 8000, bits: 32 })), chunk('data', f)]))
    expect(ext.r).toMatchObject({ ok: true, inputFormat: 'wav' })
  })
})

describe('WAV refusals (bounded, before any decoder where possible)', () => {
  const pcm = () => sinePcm16(35, 8000, 1)
  const fmt8k = () => chunk('fmt ', fmtBody({ rate: 8000, channels: 1 }))
  const cases: [string, () => Buffer, string][] = [
    ['ADPCM (ffmpeg adpcm_ms)', () => fxBuf('adpcm.wav'), 'wav_codec_unsupported'],
    ['MP3 inside a WAV', () => fxBuf('mp3-in.wav'), 'wav_codec_unsupported'],
    ['A-law', () => fxBuf('alaw.wav'), 'wav_codec_unsupported'],
    ['GSM 6.10 (tag 0x31)', () => riff([chunk('fmt ', fmtBody({ tag: 0x31, channels: 1, rate: 8000, bits: 16 })), chunk('data', pcm())]), 'wav_codec_unsupported'],
    ['EXTENSIBLE carrying a non-PCM subformat (ADPCM GUID)', () => riff([chunk('fmt ', fmtBody({ extensible: { subTag: 2 }, rate: 8000, channels: 1 })), chunk('data', pcm())]), 'wav_codec_unsupported'],
    ['EXTENSIBLE with a foreign GUID tail', () => riff([chunk('fmt ', fmtBody({ extensible: { subTag: 1, guidTail: Buffer.alloc(12, 7) }, rate: 8000, channels: 1 })), chunk('data', pcm())]), 'wav_codec_unsupported'],
    ['RF64', () => fxBuf('rf64.wav'), 'wav_rf64_unsupported'],
    ['BW64', () => Buffer.concat([Buffer.from('BW64'), fxBuf('s16-44k-stereo.wav').subarray(4)]), 'wav_rf64_unsupported'],
    ['RIFX (big-endian)', () => Buffer.concat([Buffer.from('RIFX'), fxBuf('s16-44k-stereo.wav').subarray(4)]), 'wav_unsupported'],
    ['truncated (half the file)', () => fxBuf('s16-44k-stereo.wav').subarray(0, 3_000_000), 'wav_truncated'],
    ['RIFF size 0xFFFFFFF0', () => riff([fmt8k(), chunk('data', pcm())], 0xfffffff0), 'wav_truncated'],
    ['RIFF size 0xFFFFFFFF (streaming placeholder)', () => riff([fmt8k(), chunk('data', pcm())], 0xffffffff), 'wav_unfinalized'],
    ['RIFF size 0 (streaming placeholder)', () => riff([fmt8k(), chunk('data', pcm())], 0), 'wav_unfinalized'],
    ['data size 0xFFFFFFFF (streaming placeholder)', () => riff([fmt8k(), chunk('data', pcm(), 0xffffffff)]), 'wav_unfinalized'],
    ['a WAV ffmpeg wrote to a pipe (sizes never filled in)', () => fxBuf('piped.wav'), 'wav_unfinalized'],
    ['data size larger than the RIFF', () => riff([fmt8k(), chunk('data', pcm(), pcm().length + 4096)]), 'wav_truncated'],
    ['RIFF size far smaller than the file (100 KB of trailing data)', () => {
      const w = riff([fmt8k(), chunk('data', pcm())])
      return Buffer.concat([w, Buffer.alloc(100 * 1024)])
    }, 'wav_trailing_data'],
    ['RIFF size < 4', () => riff([fmt8k(), chunk('data', pcm())], 2), 'wav_bad_riff'],
    ['a 2 MB LIST', () => simpleWav({ seconds: 31, rate: 8000, channels: 1, before: [chunk('LIST', Buffer.concat([Buffer.from('INFO'), Buffer.alloc(2 * 1024 * 1024)]))] }), 'wav_bad_list'],
    ['a LIST/INFO item declaring 100 MB inside a small LIST', () => {
      const item = Buffer.alloc(16)
      item.write('INAM', 0, 'latin1')
      item.writeUInt32LE(100 * 1024 * 1024, 4)
      return simpleWav({ seconds: 31, rate: 8000, channels: 1, before: [chunk('LIST', Buffer.concat([Buffer.from('INFO'), item]))] })
    }, 'wav_bad_list'],
    ['a 17 MB JUNK chunk', () => simpleWav({ seconds: 31, rate: 8000, channels: 1, before: [chunk('JUNK', Buffer.alloc(17 * 1024 * 1024))] }), 'wav_chunk_too_large'],
    ['70 chunks', () => simpleWav({ seconds: 31, rate: 8000, channels: 1, before: Array.from({ length: 70 }, () => chunk('junk', Buffer.alloc(2))) }), 'wav_too_many_chunks'],
    ['a chunk id with control bytes', () => simpleWav({ seconds: 31, rate: 8000, channels: 1, before: [chunk('\u0000\u0001ab', Buffer.alloc(4))] }), 'wav_bad_chunk'],
    ['data before fmt', () => riff([chunk('data', pcm()), fmt8k()]), 'wav_bad_data'],
    ['two data chunks', () => riff([fmt8k(), chunk('data', pcm()), chunk('data', pcm())]), 'wav_bad_data'],
    ['two fmt chunks', () => riff([fmt8k(), fmt8k(), chunk('data', pcm())]), 'wav_bad_fmt'],
    ['no data chunk', () => riff([fmt8k(), chunk('JUNK', pcm())]), 'wav_bad_data'],
    ['empty data chunk', () => riff([fmt8k(), chunk('data', Buffer.alloc(0)), chunk('JUNK', pcm())]), 'wav_no_audio'],
    ['block align that lies', () => riff([chunk('fmt ', fmtBody({ rate: 8000, channels: 1, blockAlign: 4 })), chunk('data', pcm())]), 'wav_bad_fmt'],
    ['byte rate that lies (duration would be wrong)', () => riff([chunk('fmt ', fmtBody({ rate: 8000, channels: 1, byteRate: 1 })), chunk('data', pcm())]), 'wav_bad_fmt'],
    ['9 channels', () => riff([chunk('fmt ', fmtBody({ rate: 8000, channels: 9 })), chunk('data', pcm())]), 'wav_channels'],
    ['4 kHz', () => riff([chunk('fmt ', fmtBody({ rate: 4000, channels: 1 })), chunk('data', pcm())]), 'wav_sample_rate'],
    ['384 kHz', () => riff([chunk('fmt ', fmtBody({ rate: 384000, channels: 1 })), chunk('data', pcm())]), 'wav_sample_rate'],
    ['12-bit PCM', () => riff([chunk('fmt ', fmtBody({ rate: 8000, channels: 1, bits: 12, blockAlign: 2, byteRate: 16000 })), chunk('data', pcm())]), 'wav_codec_unsupported'],
    ['10 s', () => fxBuf('short.wav'), 'too_short'],
    ['24 min 1 s (would not fit 35 MB even at 192 kbps)', () => riff([chunk('fmt ', fmtBody({ rate: 8000, channels: 1, bits: 8 })), chunk('data', Buffer.alloc((24 * 60 + 1) * 8000, 0x80))]), 'wav_too_long'],
    ["'id3 ' chunk with a zlib-compressed frame (bomb)", () => simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', tag(4, [zlibBombFrame(64 * 1024 * 1024)]))] }), 'id3_compressed_frame'],
    ["'id3 ' chunk over 5 MB", () => simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', tag(3, [frameV3('APIC', apicV3('image/png', Buffer.alloc(6 * 1024 * 1024)))]))] }), 'id3_too_large'],
    ["'id3 ' chunk that is not an ID3 tag", () => simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', Buffer.from('<html>not a tag</html>'))] }), 'wav_bad_id3'],
    ["'id3 ' tag declaring more than its chunk", () => {
      const t = tag(3, [frameV3('TIT2', textV3('x'))])
      return simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', t.subarray(0, t.length - 4))] })
    }, 'wav_bad_id3'],
    ['two id3 chunks', () => simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', tag(3, [frameV3('TIT2', textV3('a'))])), chunk('ID3 ', tag(3, [frameV3('TIT2', textV3('b'))]))] }), 'wav_bad_id3'],
    ['1 s of audio', () => riff([fmt8k(), chunk('data', sinePcm16(1, 8000, 1))]), 'too_short'],
  ]
  for (const [label, build, code] of cases) {
    it(`${label} → ${code} (and the upload's bytes are released)`, async () => {
      const { r, path } = await probeBuf(build())
      expect(r).toMatchObject({ ok: false, type: 'probe', error: code, released: true })
      expect(existsSync(path)).toBe(false)
    })
  }

  it('the admin-lowered WAV cap from the request applies to an actual WAV', async () => {
    const data = fxBuf('s16-44k-stereo.wav')
    expect((await probeBuf(data, { maxWavBytes: data.length - 1 })).r).toMatchObject({ ok: false, error: 'wav_too_large', released: true })
    expect((await probeBuf(data, { maxWavBytes: data.length })).r).toMatchObject({ ok: true, inputFormat: 'wav' })
  })

  it('an MP3 over 100 MB is refused by its ACTUAL type even when it was declared (and admitted) as a WAV', async () => {
    const { r, path } = await probeFx('big-101mb.mp3')
    expect(r).toMatchObject({ ok: false, error: 'mp3_too_large', released: true })
    expect(existsSync(path)).toBe(false)
  })

  it('an input over the hard 250 MB cap is refused before any byte is read (sparse file)', async () => {
    const upload = randomUUID().replace(/-/g, '')
    writeFileSync(join(dirs.uploads, upload), fxBuf('s16-44k-stereo.wav').subarray(0, 64))
    truncateSync(join(dirs.uploads, upload), MAX_WAV_UPLOAD_BYTES + 1)
    // the spool schema itself refuses such a request from the web …
    expect(probeRequest.safeParse({ v: 1, id: randomUUID(), type: 'probe', upload, expectedSize: MAX_WAV_UPLOAD_BYTES + 1 }).success).toBe(false)
    expect(probeRequest.safeParse({ v: 1, id: randomUUID(), type: 'probe', upload, expectedSize: 5, maxWavBytes: MAX_WAV_UPLOAD_BYTES + 1 }).success).toBe(false)
    // … and the probe's copy refuses the file size
    const r = await runProbe({ v: 1, id: randomUUID(), type: 'probe', upload, expectedSize: MAX_WAV_UPLOAD_BYTES }, dirs)
    expect(r).toMatchObject({ ok: false, error: 'input_size', released: true })
  })

  it('an MP3 is still an MP3 whatever it is called (the probe never sees names); a rejected MP3 is released too', async () => {
    expect((await probeFx('tagged-png.mp3')).r).toMatchObject({ ok: true, inputFormat: 'mp3', bitrate: 128000 })
    const bad = await probeFx('html.mp3')
    expect(bad.r).toMatchObject({ ok: false, error: 'not_mp3', released: true })
  })

  it('a refusal never leaves a published cover behind', async () => {
    // the WAV path publishes the cover last, and runProbe removes a published
    // cover on any later failure
    const covers = readdirSync(dirs.uploads).filter((n) => n.startsWith('cover-'))
    const before = covers.length
    await probeBuf(simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', tag(4, [frameV3('APIC', apicV3('image/png', PNG())), zlibBombFrame(1024)]))] }))
    expect(readdirSync(dirs.uploads).filter((n) => n.startsWith('cover-')).length).toBe(before)
  })
})

// Review findings (fix round 1). ffmpeg's wav demuxer reads chunks to EOF,
// past the RIFF's declared end, and its ID3v2 reader keeps reading tags after
// the first; every byte either parser reads must pass the pre-scan.
describe('WAV: bytes after the RIFF and after the id3 tag are checked too', () => {
  const base = () => simpleWav({ seconds: 31, rate: 8000, channels: 1 })
  const bomb = () => tag(4, [frameV4('TIT2', textV3('TRAILTITLE')), zlibBombFrame(1024 * 1024)])
  const benign = (t = 'benign') => tag(3, [frameV3('TIT2', textV3(t))])
  // an 'ID3x' chunk: ffmpeg's ID3 reader takes its first 10 bytes ("ID3A",
  // the chunk size, 2 body bytes) for a tag of an unsupported version and
  // skips the syncsafe length it reads there (0 0 0 6 → 6 bytes), onto the bomb
  const trampoline = () => chunk('ID3A', Buffer.concat([Buffer.from([0x00, 0x06]), Buffer.alloc(6), bomb()]))
  // the tag must end on an even offset so no chunk pad byte sits between it
  // and the next chunk
  const evenTag = () => benign('benign1')

  const refused: [string, () => Buffer, string][] = [
    ["F1a: an 'id3 ' chunk with a zlib bomb after the RIFF end", () => Buffer.concat([base(), chunk('id3 ', bomb())]), 'id3_compressed_frame'],
    ["F1b: an 'id3 ' chunk in the RIFF and an 'ID3 ' chunk after it", () => Buffer.concat([simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', benign())] }), chunk('ID3 ', benign('second'))]), 'wav_bad_id3'],
    ['F1c: a LIST/INFO after the RIFF whose item overflows it', () => {
      const item = Buffer.alloc(16)
      item.write('INAM', 0, 'latin1')
      item.writeUInt32LE(1024, 4)
      return Buffer.concat([base(), chunk('LIST', Buffer.concat([Buffer.from('INFO'), item]))])
    }, 'wav_bad_list'],
    ['a second data chunk after the RIFF', () => Buffer.concat([base(), chunk('data', Buffer.alloc(64))]), 'wav_bad_data'],
    ['bytes after the RIFF that are not a chunk', () => Buffer.concat([base(), Buffer.from('this is not a chunk header at all')]), 'wav_trailing_data'],
    ['a chunk after the RIFF that runs past the end of the file', () => Buffer.concat([base(), chunk('bext', Buffer.alloc(16), 4096)]), 'wav_trailing_data'],
    ['a chunk header straddling the RIFF end (the RIFF ends 4 bytes into it)', () => {
      const w = Buffer.concat([base(), chunk('id3 ', bomb())])
      w.writeUInt32LE(base().length - 8 + 4, 4)
      return w
    }, 'id3_compressed_frame'],
    ['zero padding after the RIFF, then a chunk', () => Buffer.concat([base(), Buffer.alloc(8), chunk('id3 ', benign())]), 'wav_trailing_data'],
    ["F2: a second ID3 tag (with a zlib bomb) inside the one 'id3 ' chunk", () => simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', Buffer.concat([benign(), bomb()]))] }), 'wav_bad_id3'],
    ["non-zero bytes after the tag inside the 'id3 ' chunk", () => simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', Buffer.concat([benign(), Buffer.from('junk')]))] }), 'wav_bad_id3'],
    ["an 'ID3x' chunk right after the tag (ffmpeg would read it as the next tag)", () => simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', evenTag()), trampoline()] }), 'wav_bad_id3'],
    ['a v2.4 footer that is really the header of a second tag', () => {
      const t = tag(4, [frameV4('TIT2', textV3('x'))])
      t[5] = t[5]! | 0x10 // footer present
      const footer = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0])
      return simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', Buffer.concat([t, footer]))] })
    }, 'wav_bad_id3'],
  ]
  for (const [label, build, code] of refused) {
    it(`${label} → ${code}`, async () => {
      const { r, path } = await probeBuf(build())
      expect(r).toMatchObject({ ok: false, type: 'probe', error: code, released: true })
      expect(existsSync(path)).toBe(false)
    })
  }

  const accepted: [string, () => Buffer][] = [
    ['one pad byte after the RIFF', () => Buffer.concat([base(), Buffer.from([0x7a])])],
    ['64 KiB of zero padding after the RIFF', () => Buffer.concat([base(), Buffer.alloc(64 * 1024)])],
    ["a well-formed 'bext' chunk after the RIFF", () => Buffer.concat([base(), chunk('bext', Buffer.alloc(602))])],
    ["an 'id3 ' chunk with zero padding after its tag", () => simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', Buffer.concat([benign('padded'), Buffer.alloc(100)]))] })],
  ]
  for (const [label, build] of accepted) {
    it(`${label} is accepted`, async () => {
      const { r } = await probeBuf(build())
      expect(r).toMatchObject({ ok: true, inputFormat: 'wav', bitrate: 320000 })
    })
  }

  it("the padded 'id3 ' tag still prefills", async () => {
    const { r } = await probeBuf(simpleWav({ seconds: 31, rate: 8000, channels: 1, after: [chunk('id3 ', Buffer.concat([benign('padded'), Buffer.alloc(100)]))] }))
    expect(r).toMatchObject({ ok: true, tags: { title: 'padded' } })
  })

  it('the trampoline chunk really does look like an ID3 header to ffmpeg (test self-check)', () => {
    const c = trampoline()
    expect(evenTag().length % 2).toBe(0)
    expect(c.toString('latin1', 0, 3)).toBe('ID3') // ff_id3v2_match: magic,
    expect(c[3] !== 0xff && c[4] !== 0xff).toBe(true) // version / flags ≠ 0xff,
    expect([c[6], c[7], c[8], c[9]].every((b) => b! < 0x80)).toBe(true) // syncsafe size
    expect(c.subarray(10 + 6, 10 + 6 + 3).toString('latin1')).toBe('ID3') // the skip lands on the bomb tag
  })
})

// Review finding F3: a restart mid-job must not leak the job's private copy
// (a WAV: up to 250 MB) in /staging/work, nor keep the rejected upload.
describe('probe start-up after an interrupted job', () => {
  it('removes every job dir left in the work dir, and nothing else (never through a symlink)', async () => {
    const r = mkdtempSync(join(tmpdir(), 'stale-'))
    const work = join(r, 'work')
    mkdirSync(work)
    const jobs = ['p', 'f', 'a'].map((k) => `${k}-${randomUUID()}-Ab3xYz`)
    for (const j of jobs) {
      mkdirSync(join(work, j))
      writeFileSync(join(work, j, 'in.wav'), Buffer.alloc(1024))
    }
    const outside = join(r, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious'), 'x')
    const link = `p-${randomUUID()}-L1nk00`
    symlinkSync(outside, join(work, link))
    writeFileSync(join(work, 'keep.txt'), 'x')
    const other = `x-${randomUUID()}-Ab3xYz`
    mkdirSync(join(work, other))
    expect(await clearStaleWork(work)).toBe(4)
    expect(readdirSync(work).sort()).toEqual(['keep.txt', other].sort())
    expect(readFileSync(join(outside, 'precious'), 'utf8')).toBe('x')
  })

  it("an interrupted in-web probe is answered as a probe rejection and its upload released; an answered one and other types are left alone", async () => {
    const r = mkdtempSync(join(tmpdir(), 'interrupt-'))
    const spool = join(r, 'spool')
    const uploads = join(r, 'uploads')
    for (const d of [uploads, join(spool, 'claimed'), join(spool, 'out')]) mkdirSync(d, { recursive: true })
    const up = () => {
      const u = randomUUID().replace(/-/g, '')
      writeFileSync(join(uploads, u), Buffer.alloc(4096))
      return u
    }
    const claim = (inbox: string, req: { id: string } & Record<string, unknown>) => writeFileSync(join(spool, 'claimed', `${inbox}-${req.id}.json`), JSON.stringify(req))

    const lost = { v: 1, id: randomUUID(), type: 'probe', upload: up(), expectedSize: 4096 }
    claim('in-web', lost)
    writeFileSync(join(uploads, `cover-${lost.id}.jpg`), 'jpg') // published just before the crash
    // answered before the crash (the result was written, the claim not yet removed): its upload is in use
    const answered = { v: 1, id: randomUUID(), type: 'probe', upload: up(), expectedSize: 4096 }
    claim('in-web', answered)
    writeFileSync(join(spool, 'out', `${answered.id}.json`), JSON.stringify({ v: 1, id: answered.id, source: 'in-web', type: 'probe', ok: false, error: 'not_mp3', released: false }))
    const fin = { v: 1, id: randomUUID(), type: 'finalize', upload: up(), approvedSha256: '0'.repeat(64), tags: { title: 'a', artist: 'b', album: '', genre: '' }, cover: null }
    claim('in-worker', fin)

    await recoverInterrupted({ spool, uploads })
    expect(await readSpoolResult(join(spool, 'out'), lost.id)).toMatchObject({ source: 'in-web', type: 'probe', ok: false, error: 'interrupted', released: true })
    expect(existsSync(join(uploads, lost.upload))).toBe(false)
    expect(existsSync(join(uploads, `cover-${lost.id}.jpg`))).toBe(false)
    expect(await readSpoolResult(join(spool, 'out'), answered.id)).toMatchObject({ error: 'not_mp3' })
    expect(existsSync(join(uploads, answered.upload))).toBe(true)
    expect(await readSpoolResult(join(spool, 'out'), fin.id)).toMatchObject({ source: 'in-worker', ok: false, error: 'interrupted' })
    expect(existsSync(join(uploads, fin.upload))).toBe(true)
    expect(readdirSync(join(spool, 'claimed'))).toEqual([])
  })
})

describe('WAV helpers', () => {
  it('magic bytes, never the name', () => {
    expect(sniffWav(fxBuf('s16-44k-stereo.wav'))).toBe('wav')
    expect(sniffWav(fxBuf('rf64.wav'))).toBe('rf64')
    expect(sniffWav(fxBuf('raw35.mp3'))).toBeNull()
    expect(sniffWav(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBeNull() // a WebP is RIFF too
  })

  it('target sample rates', () => {
    expect([44100, 48000, 96000, 192000, 144000, 88200, 176400, 22050, 32000, 8000, 24000].map(targetRate)).toEqual([
      44100, 48000, 48000, 48000, 48000, 44100, 44100, 44100, 44100, 44100, 44100,
    ])
  })

  it('ffprobe and ffmpeg are forced to the wav demuxer, file/pipe only, one thread; conversion is CBR 320k libmp3lame', () => {
    expect(wavFfprobeArgs('/w/in.wav').join(' ')).toContain('-protocol_whitelist file,pipe -f wav -threads 1')
    const a = convertArgs('/w/in.wav', '/w/out.mp3', { channels: 6, sampleRate: 96000 }, 320_000).join(' ')
    expect(a).toContain('-protocol_whitelist file,pipe -threads 1 -filter_threads 1 -f wav -i file:/w/in.wav')
    expect(a).toContain('-map 0:a:0 -map_metadata -1')
    expect(a).toContain('-ac 2 -ar 48000 -c:a libmp3lame -b:a 320k -threads 1')
    expect(a.endsWith('-f mp3 file:/w/out.mp3')).toBe(true)
    const mono = convertArgs('/w/in.wav', '/w/out.mp3', { channels: 1, sampleRate: 44100 }, 192_000).join(' ')
    expect(mono).not.toContain('-ac ')
    expect(mono).not.toContain('-ar ')
    expect(mono).toContain('-c:a libmp3lame -b:a 192k -threads 1')
    expect(() => convertArgs('/w/in.wav', '/w/out.mp3', { channels: 1, sampleRate: 44100 }, 321_000)).toThrow()
  })

  it('the conversion runs under prlimit → timeout → nice 19', () => {
    const argv = limitedArgv('ffmpeg', ['-i', 'x'], 1024, CONVERT_TIMEOUT_S, CONVERT_NICE)
    expect(argv).toEqual(['--as=1048576', '--core=0', '--', TIMEOUT, '-s', 'KILL', '-k', '1', String(CONVERT_TIMEOUT_S), NICE, '-n', '19', 'ffmpeg', '-i', 'x'])
    expect(() => limitedArgv('x', [], 1024, 1, 0)).toThrow()
    expect(() => limitedArgv('x', [], 1024, 1, 20)).toThrow()
    expect(existsSync(NICE)).toBe(true)
  })

  it('ffprobe judge: the header walk and ffprobe must agree', async () => {
    const info = await scanWav(reader(fx('s16-44k-stereo.wav')), fxBuf('s16-44k-stereo.wav').length)
    const ok = { format: { format_name: 'wav', duration: '35.000000' }, streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 2, sample_rate: '44100' }] }
    expect(judgeWavFfprobe(ok, info)).toMatchObject({ codec: 'pcm_s16le' })
    expect(() => judgeWavFfprobe({ ...ok, streams: [{ ...ok.streams[0], codec_name: 'adpcm_ms' }] }, info)).toThrow('wav_codec_unsupported')
    expect(() => judgeWavFfprobe({ ...ok, streams: [...ok.streams, ok.streams[0]] }, info)).toThrow('wav_not_single_stream')
    expect(() => judgeWavFfprobe({ ...ok, streams: [{ ...ok.streams[0], channels: 1 }] }, info)).toThrow('wav_header_mismatch')
    expect(() => judgeWavFfprobe({ ...ok, format: { ...ok.format, duration: '70' } }, info)).toThrow('wav_header_mismatch')
    expect(() => judgeWavFfprobe({ ...ok, format: { ...ok.format, format_name: 'mp3' } }, info)).toThrow('not_wav')
    expect(MAX_DURATION_S).toBe(1440) // v0.3.5: 24 min, the same as an MP3 (was 15 min)
  })
})
