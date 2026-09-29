// v0.3.5 fit-to-size, probe side, run in-process in the test image (same
// ffmpeg / ffprobe / prlimit / bundled music-metadata child as the probe
// image). The final MP3 must fit MAX_UPLOAD_BYTES (35 MiB) with its cover and
// tags: an MP3 that already fits is kept byte for byte; a bigger MP3 (or any
// WAV) is encoded to CBR at the highest ladder rate that fits (320 → 256 →
// 192 kbps); a song too long even for 192 kbps is rejected.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import NodeID3 from 'node-id3'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  AUDIO_BUDGET_BYTES,
  AUDIO_PAYLOAD_BYTES,
  BITRATE_LADDER,
  CONTAINER_MARGIN_BYTES,
  MAX_DURATION_S,
  MAX_FINAL_COVER_BYTES,
  MAX_MP3_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_WAV_UPLOAD_BYTES,
  maxDurationAt,
  mp3FitsUntouched,
  pickBitrate,
  TAG_MARGIN_BYTES,
  transcodeLabel,
} from '@/lib/fit'
import { runLimited } from '@/probe/exec'
import { runFinalize } from '@/probe/finalize'
import { countedDurationS, countFramesArgs, runProbe } from '@/probe/probe'
import { mp3TargetRate, mp3TranscodeArgs } from '@/probe/transcode'
import { CONVERT_NICE, CONVERT_TIMEOUT_S, CONVERT_VMEM_KB } from '@/probe/wav'
import { probeRequest, spoolResult } from '@/server/spool/protocol'
import { ticketLine } from '@/worker/handlers'
import { fx, fxBuf } from './helpers/fixtures'
import { apicV3, frameV3, tag, textV3 } from './helpers/id3'
import { chunk, fmtBody, riff, sinePcm16 } from './helpers/wav'
import { forgeXingFrames } from './helpers/xing'

const MIB = 1024 * 1024
const MM = resolve('dist/probe/mm-child.mjs')
let root: string
let dirs: { uploads: string; work: string; mmChild: string }
const finalDir = () => join(root, 'final')

function stage(data: Buffer): { upload: string; size: number } {
  const upload = randomUUID().replace(/-/g, '')
  writeFileSync(join(dirs.uploads, upload), data)
  return { upload, size: data.length }
}

async function probe(data: Buffer, extra: { maxMp3Bytes?: number } = {}) {
  const s = stage(data)
  const r = await runProbe({ v: 1, id: randomUUID(), type: 'probe', upload: s.upload, expectedSize: s.size, ...extra }, dirs)
  expect(spoolResult.safeParse(r).success).toBe(true) // the worker can read what the probe wrote
  return { r, upload: s.upload, path: join(dirs.uploads, s.upload) }
}

type Probed = { format: { duration: string; format_name: string; bit_rate: string }; streams: { codec_type: string; codec_name: string; sample_rate: string; channels: number; bit_rate: string }[] }
function ffprobeJson(file: string): Probed {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString())
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

// CBR: every frame has the same length, give or take the one padding byte.
function isCbr(file: string): boolean {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', file], { maxBuffer: 64 * MIB }).toString()
  const sizes = out.trim().split('\n').map((l) => parseInt(l, 10)) // some lines end in ','
  const max = sizes.reduce((a, b) => Math.max(a, b), 0)
  const min = sizes.reduce((a, b) => Math.min(a, b), Infinity)
  return sizes.length > 100 && max - min <= 1
}

// forgeXingFrames (helpers/xing.ts): a copy whose Xing / Info header claims
// another length; the byte count stays true, so ffmpeg trusts it.
function stageTmp(data: Buffer): string {
  const f = join(mkdtempSync(join(root, 'tmp-')), 'x.mp3')
  writeFileSync(f, data)
  return f
}

const basicTags = (title: string) => [frameV3('TIT2', textV3(title)), frameV3('TPE1', textV3('Fit Artist')), frameV3('TALB', textV3('Fit Album')), frameV3('TCON', textV3('Trance'))]

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fitprobe-'))
  dirs = { uploads: join(root, 'uploads'), work: join(root, 'work'), mmChild: MM }
  for (const d of [dirs.uploads, dirs.work, finalDir()]) mkdirSync(d, { recursive: true })
  expect(existsSync(MM)).toBe(true)
})

describe('fit.ts: the budget and the ladder (one shared function for probe, UI and tests)', () => {
  it('audio budget = 35 MiB − 2 MiB cover − 16 KiB tag margin; payload leaves 16 KiB for the stream overhead', () => {
    expect(MAX_UPLOAD_BYTES).toBe(36_700_160)
    expect(MAX_FINAL_COVER_BYTES).toBe(2 * MIB)
    expect(AUDIO_BUDGET_BYTES).toBe(36_700_160 - 2_097_152 - 16_384) // 34,586,624
    expect(AUDIO_PAYLOAD_BYTES).toBe(AUDIO_BUDGET_BYTES - CONTAINER_MARGIN_BYTES) // 34,570,240
    expect(MAX_MP3_UPLOAD_BYTES).toBe(100 * MIB)
    expect(MAX_WAV_UPLOAD_BYTES).toBe(250 * MIB)
  })

  it('max durations: 864 s @320k (14.4 min), 1080 s @256k (18.0 min), 1440 s @192k (24.0 min)', () => {
    expect(BITRATE_LADDER).toEqual([320_000, 256_000, 192_000])
    expect(BITRATE_LADDER.map(maxDurationAt)).toEqual([864, 1080, 1440])
    expect(MAX_DURATION_S).toBe(1440)
    for (const r of BITRATE_LADDER) expect((maxDurationAt(r) * r) / 8).toBeLessThanOrEqual(AUDIO_PAYLOAD_BYTES)
    for (const r of BITRATE_LADDER) expect(((maxDurationAt(r) + 1) * r) / 8).toBeGreaterThan(AUDIO_PAYLOAD_BYTES)
  })

  it('pickBitrate: the highest rate that fits, null past the floor', () => {
    expect(pickBitrate(30)).toBe(320_000)
    expect(pickBitrate(864)).toBe(320_000)
    expect(pickBitrate(864.1)).toBe(256_000)
    expect(pickBitrate(960)).toBe(256_000)
    expect(pickBitrate(1080)).toBe(256_000)
    expect(pickBitrate(1080.5)).toBe(192_000)
    expect(pickBitrate(1320)).toBe(192_000)
    expect(pickBitrate(1440)).toBe(192_000)
    expect(pickBitrate(1440.01)).toBeNull()
    expect(pickBitrate(Number.NaN)).toBeNull()
  })

  it('an MP3 fits untouched when its audio (without the leading ID3 tag) fits and the file fits finalize', () => {
    expect(mp3FitsUntouched(AUDIO_PAYLOAD_BYTES, 0)).toBe(true)
    expect(mp3FitsUntouched(AUDIO_PAYLOAD_BYTES + 1, 0)).toBe(false)
    expect(mp3FitsUntouched(AUDIO_PAYLOAD_BYTES + 3 * MIB, 3 * MIB)).toBe(false) // over MAX_UPLOAD_BYTES as a file
    expect(mp3FitsUntouched(AUDIO_PAYLOAD_BYTES + MIB, MIB)).toBe(true)
  })

  it('the finalize tag, worst case (4 × 200 UTF-16 units + a 2 MiB cover), stays inside cover + tag margin', () => {
    const long = '\u{1F3B5}'.repeat(100) // 200 UTF-16 code units, the tagString maximum
    const t = NodeID3.create({
      title: long,
      artist: long,
      album: long,
      genre: long,
      image: { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer: Buffer.alloc(MAX_FINAL_COVER_BYTES, 0xff) },
    })
    expect(t.length - MAX_FINAL_COVER_BYTES).toBeLessThanOrEqual(TAG_MARGIN_BYTES)
  })

  it('labels', () => {
    expect(transcodeLabel('wav', 256)).toBe('Converted from WAV (256 kbps MP3)')
    expect(transcodeLabel('mp3', 192)).toBe('Re-encoded to 192 kbps to fit')
    expect(transcodeLabel('mp3', null)).toBeNull()
  })

  it('the ticket card says so, and keeps the note whole when the name is long', () => {
    const base = { id: 12, kind: 'song' as const, newArtistName: null, artist: 'A', title: 'T', inputFormat: 'mp3', transcodeKbps: 192 }
    expect(ticketLine(base)).toBe('#12 A - T (Re-encoded to 192 kbps to fit)')
    expect(ticketLine({ ...base, inputFormat: 'wav', transcodeKbps: 256 })).toBe('#12 A - T (Converted from WAV (256 kbps MP3))')
    expect(ticketLine({ ...base, transcodeKbps: null })).toBe('#12 A - T')
    const long = ticketLine({ ...base, title: 'x'.repeat(300) })
    expect(long.length).toBe(200)
    expect(long.endsWith('(Re-encoded to 192 kbps to fit)')).toBe(true)
  })

  it('the probe request carries the (admin-lowered) MP3 input cap, never above 100 MB', () => {
    const base = { v: 1, id: randomUUID(), type: 'probe', upload: 'a'.repeat(32), expectedSize: 5 }
    expect(probeRequest.safeParse({ ...base, maxMp3Bytes: 100 * MIB }).success).toBe(true)
    expect(probeRequest.safeParse({ ...base, maxMp3Bytes: 100 * MIB + 1 }).success).toBe(false)
  })
})

describe('MP3 inputs', () => {
  it('an MP3 that fits (14 min of 320 kbps, 33.6 MB) is kept byte for byte: no re-encode', async () => {
    const data = fxBuf('fit-14m-320k.mp3')
    expect(data.length).toBeGreaterThan(32 * MIB)
    const { r, path } = await probe(data)
    if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
    expect(r).toMatchObject({ inputFormat: 'mp3', bitrate: 320000, size: data.length, flags: [] })
    expect(r.transcodeKbps).toBeUndefined()
    expect(r.sha256).toBe(sha(data))
    expect(sha(readFileSync(path))).toBe(sha(data)) // the staged upload is untouched
  }, 120_000)

  it('the leading ID3 tag does not count: 33.6 MB of audio behind a 1.5 MB tag (APIC + padding) is still untouched', async () => {
    const data = Buffer.concat([tag(3, [...basicTags('Tagged'), frameV3('APIC', apicV3('image/png', fxBuf('cover.png')))], 1.5 * MIB), fxBuf('fit-14m-320k.mp3')])
    expect(data.length).toBeGreaterThan(AUDIO_PAYLOAD_BYTES)
    expect(data.length).toBeLessThanOrEqual(MAX_UPLOAD_BYTES)
    const { r, path } = await probe(data)
    if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
    expect(r.transcodeKbps).toBeUndefined()
    expect(readFileSync(path).equals(data)).toBe(true)
  }, 120_000)

  // Second pass (security review): the kept-untouched path reported, and
  // capped, ffprobe's duration, which the upload's own Xing header sets. Now
  // the frames are counted there too (keptMp3DurationS).
  it('v0.4.1: a forged Xing header on an MP3 that FITS (26 min of 128 kbps, 25 MB, claiming 10 min) → too_long from the counted frames', async () => {
    const real = fxBuf('fit-26m-128k.mp3')
    expect(real.length).toBeLessThanOrEqual(AUDIO_PAYLOAD_BYTES) // the untouched path, not the re-encode
    const data = forgeXingFrames(real, 600)
    expect(Number(ffprobeJson(stageTmp(data)).format.duration)).toBeCloseTo(600, 0) // the lie works on ffprobe's header read
    const { r, path } = await probe(data)
    // (before: ok, kept untouched, durationS 600 → to review, and on air, as 10 min)
    expect(r).toMatchObject({ ok: false, error: 'too_long', released: true })
    expect(existsSync(path)).toBe(false)
  }, 120_000)

  it('v0.4.1: a kept MP3 reports its counted length, not its header (10 min of 320 kbps claiming 20 min → 600 s)', async () => {
    const data = forgeXingFrames(fxBuf('fit-10m-320k.mp3'), 1200)
    expect(Number(ffprobeJson(stageTmp(data)).format.duration)).toBeCloseTo(1200, 0)
    const { r } = await probe(data)
    if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
    expect(r.transcodeKbps).toBeUndefined() // still kept byte for byte
    expect(r.sha256).toBe(sha(data))
    expect(r.durationS).toBeGreaterThanOrEqual(599)
    expect(r.durationS).toBeLessThanOrEqual(601)
  }, 120_000)

  it('a 22.05 kHz MP3 (MPEG-2, at most 160 kbps) always fits and stays untouched', async () => {
    const data = fxBuf('fit-10m-160k-22k.mp3')
    const { r, path } = await probe(data)
    if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
    expect(r).toMatchObject({ inputFormat: 'mp3', bitrate: 160000 })
    expect(r.transcodeKbps).toBeUndefined()
    expect(readFileSync(path).equals(data)).toBe(true)
  }, 120_000)

  it('16 min of 320 kbps with tags + APIC (38 MB) → re-encoded to CBR 256k; tags and cover from the original survive finalize; final ≤ 35 MiB', async () => {
    const png = fxBuf('cover.png')
    const orig = Buffer.concat([tag(3, [...basicTags('Sixteen'), frameV3('APIC', apicV3('image/png', png))]), fxBuf('fit-16m-320k.mp3')])
    expect(orig.length).toBeGreaterThan(MAX_UPLOAD_BYTES)
    const { r, upload, path } = await probe(orig)
    if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
    expect(r).toMatchObject({ inputFormat: 'mp3', transcodeKbps: 256, bitrate: 256000, flags: ['reencoded_to_fit'] })
    expect(r.tags).toMatchObject({ title: 'Sixteen', artist: 'Fit Artist', album: 'Fit Album', genre: 'Trance' })
    expect(r.cover).not.toBeNull()
    expect(r.durationS).toBeGreaterThanOrEqual(959)
    expect(r.durationS).toBeLessThanOrEqual(961)
    // the staged upload is now the re-encoded MP3 (the original is gone)
    const staged = readFileSync(path)
    expect(r.sha256).toBe(sha(staged))
    expect(r.size).toBe(staged.length)
    expect(staged.length).toBeLessThanOrEqual(AUDIO_BUDGET_BYTES)
    expect(staged.subarray(0, 3).toString('latin1')).not.toBe('ID3') // finalize writes the tags
    const j = ffprobeJson(path)
    expect(j.streams).toHaveLength(1) // the APIC picture was dropped
    expect(j.streams[0]).toMatchObject({ codec_name: 'mp3', sample_rate: '44100', channels: 2, bit_rate: '256000' })
    expect(isCbr(path)).toBe(true)

    // finalize (unchanged) → clean ID3 + APIC, final file within the cap
    const fin = await runFinalize(
      { v: 1, id: randomUUID(), type: 'finalize', upload, approvedSha256: r.sha256, tags: { title: 'Sixteen', artist: 'Fit Artist', album: 'Fit Album', genre: 'Trance' }, cover: { file: r.cover!.file, sha256: r.cover!.sha256 } },
      { uploads: dirs.uploads, work: dirs.work, final: finalDir() },
    )
    if (!fin.ok || fin.type !== 'finalize') throw new Error(JSON.stringify(fin))
    const out = join(finalDir(), fin.file)
    expect(statSync(out).size).toBeLessThanOrEqual(MAX_UPLOAD_BYTES)
    const t = NodeID3.read(out)
    expect(t).toMatchObject({ title: 'Sixteen', artist: 'Fit Artist', album: 'Fit Album', genre: 'Trance' })
    expect((t.image as { imageBuffer: Buffer }).imageBuffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(ffprobeJson(out).streams.find((s) => s.codec_type === 'audio')).toMatchObject({ bit_rate: '256000' })
  }, 600_000)

  it('1090 s of 320 kbps at 48 kHz (43.6 MB, just past the 256k limit) → CBR 192k, 48 kHz kept', async () => {
    const { r, path } = await probe(fxBuf('fit-1090s-320k-48k.mp3'))
    if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
    expect(r).toMatchObject({ inputFormat: 'mp3', transcodeKbps: 192, bitrate: 192000 })
    expect(r.size).toBeLessThanOrEqual(AUDIO_BUDGET_BYTES)
    expect(ffprobeJson(path).streams[0]).toMatchObject({ sample_rate: '48000', channels: 2, bit_rate: '192000' })
    expect(Number(ffprobeJson(path).format.duration)).toBeCloseTo(1090, 0)
  }, 600_000)

  it('a VBR MP3 (LAME V0, ~250 kbps, 20 min) over the budget → CBR at the rate its duration allows (192k)', async () => {
    const data = fxBuf('fit-20m-v0.mp3')
    expect(data.length).toBeGreaterThan(AUDIO_PAYLOAD_BYTES)
    const { r, path } = await probe(data)
    if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
    expect(r).toMatchObject({ inputFormat: 'mp3', transcodeKbps: 192, bitrate: 192000 })
    expect(isCbr(path)).toBe(true)
  }, 600_000)

  it('26 min of 320 kbps → too_long (would not fit even at 192 kbps), refused before anything decodes; the bytes are released', async () => {
    const { r, path } = await probe(fxBuf('fit-26m-320k.mp3'))
    expect(r).toMatchObject({ ok: false, error: 'too_long', released: true })
    expect(existsSync(path)).toBe(false)
  }, 120_000)

  // Review finding S2: the rate (and so how long the decode runs) came from
  // ffprobe's duration, which an upload's own Xing header sets. Now it is
  // counted from the frames the demuxer reads (countedDurationS).
  it('a forged Xing frame count (26 min claiming 10 min) → too_long from the counted frames, before anything decodes', async () => {
    const data = forgeXingFrames(fxBuf('fit-26m-320k.mp3'), 600)
    expect(Number(ffprobeJson(stageTmp(data)).format.duration)).toBeCloseTo(600, 0) // the lie works on ffprobe's header read
    const { r, path } = await probe(data)
    // (before: pickBitrate(600) = 320k, a decode run to the -t cap, then reencoded_too_large)
    expect(r).toMatchObject({ ok: false, error: 'too_long', released: true })
    expect(existsSync(path)).toBe(false)
  }, 120_000)

  it('a forged Xing frame count (16 min claiming 10 min) → the rate its real length allows (256k), not 320k', async () => {
    const data = forgeXingFrames(fxBuf('fit-16m-320k.mp3'), 600)
    const { r, path } = await probe(data)
    if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
    expect(r).toMatchObject({ inputFormat: 'mp3', transcodeKbps: 256, bitrate: 256000 })
    expect(r.durationS).toBeGreaterThanOrEqual(959)
    expect(r.durationS).toBeLessThanOrEqual(961)
    expect(ffprobeJson(path).streams[0]).toMatchObject({ bit_rate: '256000' })
  }, 600_000)

  it('countedDurationS counts the frames: exact for a CBR file, unmoved by a forged header', async () => {
    const work = mkdtempSync(join(root, 'cnt-'))
    expect(await countedDurationS(fx('fit-16m-320k.mp3'), work, 44100)).toBeCloseTo(960, 0)
    expect(await countedDurationS(stageTmp(forgeXingFrames(fxBuf('fit-16m-320k.mp3'), 600)), work, 44100)).toBeCloseTo(960, 0)
    await expect(countedDurationS(fx('fit-16m-320k.mp3'), work, 48000)).rejects.toMatchObject({ code: 'not_mp3' })
    expect(countFramesArgs('/w/in.mp3').join(' ')).toBe(
      '-hide_banner -v error -protocol_whitelist file,pipe -f mp3 -threads 1 -count_packets -select_streams a:0 -show_entries stream=nb_read_packets,sample_rate -print_format json file:/w/in.mp3',
    )
  }, 120_000)

  // Review finding m1: trailing data after the last frame inflated ffprobe's
  // duration, so the re-encode's output was refused as reencode_invalid.
  it('10 min of 320 kbps + 14 MiB of trailing zero bytes (38.7 MB) → re-encoded at 320k, as long as its real audio', async () => {
    const data = Buffer.concat([fxBuf('fit-10m-320k.mp3'), Buffer.alloc(14 * MIB)])
    expect(data.length).toBeGreaterThan(MAX_UPLOAD_BYTES)
    const { r, path } = await probe(data)
    if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
    expect(r).toMatchObject({ inputFormat: 'mp3', transcodeKbps: 320, bitrate: 320000 })
    expect(r.durationS).toBeGreaterThanOrEqual(599)
    expect(r.durationS).toBeLessThanOrEqual(601)
    expect(r.size).toBeLessThan(25 * 1000 * 1000)
    expect(Number(ffprobeJson(path).format.duration)).toBeCloseTo(600, 0)
  }, 600_000)

  it('the admin-lowered MP3 cap from the request applies to an actual MP3', async () => {
    const data = fxBuf('tagged-png.mp3')
    expect((await probe(data, { maxMp3Bytes: data.length - 1 })).r).toMatchObject({ ok: false, error: 'mp3_too_large', released: true })
    expect((await probe(data, { maxMp3Bytes: data.length })).r).toMatchObject({ ok: true, inputFormat: 'mp3' })
  })

  it('the re-encode argv: forced mp3 demuxer AND decoder, file/pipe only, one thread, non-audio streams discarded at the demuxer, duration-capped, CBR', () => {
    const a = mp3TranscodeArgs('/w/in.mp3', '/w/out.mp3', { sampleRate: 22050, channels: 2 }, 256_000).join(' ')
    expect(a).toContain('-nostdin')
    expect(a).toContain('-protocol_whitelist file,pipe -threads 1 -filter_threads 1 -vn -sn -dn -c:a mp3float -f mp3 -i file:/w/in.mp3')
    expect(a).toContain('-map 0:a:0 -map_metadata -1 -map_chapters -1 -vn -sn -dn')
    expect(a).toContain(`-ar 44100 -t ${MAX_DURATION_S + 5} -fs ${AUDIO_BUDGET_BYTES + 1} -c:a libmp3lame -b:a 256k -threads 1 -id3v2_version 0 -write_id3v1 0 -f mp3 file:/w/out.mp3`)
    expect(mp3TranscodeArgs('/w/in.mp3', '/w/out.mp3', { sampleRate: 48000, channels: 1 }, 192_000).join(' ')).not.toMatch(/-ar |-ac /)
    expect([44100, 48000, 32000, 24000, 22050, 16000, 12000, 11025, 8000].map(mp3TargetRate)).toEqual([44100, 48000, 44100, 44100, 44100, 44100, 44100, 44100, 44100])
    expect(() => mp3TranscodeArgs('/w/in.mp3', '/w/out.mp3', { sampleRate: 44100, channels: 2 }, 330_000)).toThrow()
  })

  it('the re-encode itself, under the probe limits: a 22.05 kHz MP3 → 44.1 kHz CBR at the ladder rate', async () => {
    const work = mkdtempSync(join(root, 'tx-'))
    const out = join(work, 'out.mp3')
    const c = await runLimited('ffmpeg', mp3TranscodeArgs(fx('clip-160k-22k.mp3'), out, { sampleRate: 22050, channels: 2 }, 320_000), {
      timeoutS: CONVERT_TIMEOUT_S,
      vmemKb: CONVERT_VMEM_KB,
      cwd: work,
      nice: CONVERT_NICE,
    })
    expect(c.code, c.stderr).toBe(0)
    const j = ffprobeJson(out)
    expect(j.streams).toHaveLength(1)
    expect(j.streams[0]).toMatchObject({ codec_name: 'mp3', sample_rate: '44100', channels: 2, bit_rate: '320000' })
    expect(Number(j.format.duration)).toBeCloseTo(60, 0)
  }, 120_000)
})

// Review finding S1: finalize holds the final-file cap itself.
describe('finalize never publishes a file over MAX_UPLOAD_BYTES', () => {
  it('890 s of 320 kbps (35.6 MB, within finalize\'s input cap) + a 1.5 MiB cover → final_too_large, nothing published', async () => {
    const upload = randomUUID().replace(/-/g, '')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'mp3', '-i', fx('fit-16m-320k.mp3'), '-t', '890', '-c', 'copy', '-id3v2_version', '0', '-write_id3v1', '0', '-f', 'mp3', join(dirs.uploads, upload)])
    const audio = readFileSync(join(dirs.uploads, upload))
    expect(audio.length).toBeLessThanOrEqual(MAX_UPLOAD_BYTES)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1.5 * MIB - 6, 0x55), Buffer.from([0xff, 0xd9])])
    expect(audio.length + jpeg.length).toBeGreaterThan(MAX_UPLOAD_BYTES)
    const coverFile = `cover-${randomUUID()}.jpg`
    writeFileSync(join(dirs.uploads, coverFile), jpeg)
    const id = randomUUID()
    const fin = await runFinalize(
      { v: 1, id, type: 'finalize', upload, approvedSha256: sha(audio), tags: { title: 'Big', artist: 'A', album: 'B', genre: 'Trance' }, cover: { file: coverFile, sha256: sha(jpeg) } },
      { uploads: dirs.uploads, work: dirs.work, final: finalDir() },
    )
    expect(fin).toMatchObject({ ok: false, error: 'final_too_large' })
    expect(existsSync(join(finalDir(), `${id}.mp3`))).toBe(false)
    // the same audio without the cover fits, and is published
    const ok = await runFinalize(
      { v: 1, id: randomUUID(), type: 'finalize', upload, approvedSha256: sha(audio), tags: { title: 'Big', artist: 'A', album: 'B', genre: 'Trance' }, cover: null },
      { uploads: dirs.uploads, work: dirs.work, final: finalDir() },
    )
    if (!ok.ok || ok.type !== 'finalize') throw new Error(JSON.stringify(ok))
    expect(ok.size).toBeLessThanOrEqual(MAX_UPLOAD_BYTES)
  }, 120_000)
})

describe('WAV inputs take the same ladder', () => {
  // 8 kHz mono 16-bit sine (small files), resampled to 44.1 kHz by the conversion.
  const wav = (seconds: number) => riff([chunk('fmt ', fmtBody({ rate: 8000, channels: 1, bits: 16 })), chunk('data', sinePcm16(seconds, 8000, 1))])
  // Just past each step: 870 s (> 864 s, the 320k limit) and 1090 s (> 1080 s,
  // the 256k limit). A WAV that fits at 320k: wav-probe.test.ts (35 s WAVs).
  const cases: [number, number][] = [
    [870, 256],
    [1090, 192],
  ]
  for (const [seconds, kbps] of cases) {
    it(`a ${seconds} s WAV → CBR ${kbps}k MP3 within the audio budget`, async () => {
      const { r, path } = await probe(wav(seconds))
      if (!r.ok || r.type !== 'probe' || !('sha256' in r)) throw new Error(JSON.stringify(r))
      expect(r).toMatchObject({ inputFormat: 'wav', transcodeKbps: kbps, bitrate: kbps * 1000, flags: ['converted_from_wav'] })
      expect(r.size).toBeLessThanOrEqual(AUDIO_BUDGET_BYTES)
      expect(ffprobeJson(path).streams[0]).toMatchObject({ sample_rate: '44100', bit_rate: String(kbps * 1000) })
      expect(Math.abs(r.durationS - seconds)).toBeLessThanOrEqual(1)
    }, 600_000)
  }
  it('a 24-min 1-s WAV → wav_too_long', async () => {
    expect((await probe(wav(24 * 60 + 1))).r).toMatchObject({ ok: false, error: 'wav_too_long', released: true })
  }, 120_000)
})
