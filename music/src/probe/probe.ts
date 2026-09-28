// 'probe' requests (from in-web only): plan §3.4 steps 1–6, plus (v0.3.0)
// WAV inputs, which are checked and converted to a CBR MP3 (wav.ts), and
// (v0.3.2) fit-to-size: an MP3 whose audio does not fit the final-file cap
// is re-encoded to a smaller CBR MP3 (transcode.ts). The rules and numbers
// are in src/lib/fit.ts.
//
// The input type is decided by magic bytes on the probe-private copy, never
// by the upload's name or declared type: RIFF....WAVE → the WAV path,
// anything else → the MP3 path. Each path applies its own size cap (MP3
// ≤ the request's maxMp3Bytes ≤ MAX_MP3_UPLOAD_BYTES, WAV ≤ the request's
// maxWavBytes ≤ MAX_WAV_UPLOAD_BYTES), on top of the web's cap by declared
// type.
//
// A rejected upload's bytes are useless (no preview, never submitted), so the
// probe deletes them from /staging/uploads at once and says so (`released`);
// the worker then releases them from the staging quota. A large WAV would
// otherwise hold up to 250 MB of the shared staging budget for 7 days.

import { chmod, mkdtemp, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AUDIO_BUDGET_BYTES, MAX_DURATION_S, mp3FitsUntouched, pickBitrate } from '../lib/fit'
import { MAX_MP3_UPLOAD_BYTES, MAX_PROBE_INPUT_BYTES, MAX_WAV_UPLOAD_BYTES, type ProbeRequest, type SpoolResult } from '../server/spool/protocol'
import { imageDims, reencodeCover } from './cover'
import { runLimited } from './exec'
import { copyNoFollowHashed, ProbeReject, publishFile, reader, sha256File } from './files'
import { MAX_TAG_BYTES, scanId3 } from './id3scan'
import { checkMp3Magic, id3v2TagSize } from './magic'
import { mp3TranscodeArgs } from './transcode'
import { CONVERT_NICE, CONVERT_TIMEOUT_S, CONVERT_VMEM_KB, convertArgs, judgeWavFfprobe, scanWav, sniffWav, wavFfprobeArgs, type WavInfo } from './wav'

export type ProbeDirs = { uploads: string; work: string; mmChild: string }

export const MIN_DURATION_S = 30
// v0.3.2: the longest song that fits at the ladder's floor (fit.ts, 24 min),
// for MP3 and WAV alike (was 20 min for an MP3).
export { MAX_DURATION_S }
export const MIN_BITRATE = 128_000

export function ffprobeArgs(file: string): string[] {
  return [
    '-hide_banner',
    '-v', 'error',
    '-protocol_whitelist', 'file,pipe',
    '-f', 'mp3',
    '-threads', '1',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    `file:${file}`,
  ]
}

const ffprobeOut = z.object({
  streams: z.array(
    z
      .object({
        codec_type: z.string(),
        codec_name: z.string().optional(),
        bit_rate: z.string().optional(),
        sample_rate: z.string().optional(),
        channels: z.number().int().optional(),
        disposition: z.object({ attached_pic: z.number().optional() }).passthrough().optional(),
      })
      .passthrough(),
  ),
  format: z.object({ format_name: z.string(), duration: z.string().optional(), bit_rate: z.string().optional() }).passthrough(),
})

// sampleRate / channels: what a re-encode needs (null if ffprobe did not say).
export type Mp3Info = { durationS: number; bitrate: number; sampleRate: number | null; channels: number | null }

// `maxDurationS`: MAX_DURATION_S for an upload; the probe's own encoded
// output is judged with a few seconds' allowance (its -t cap).
export function judgeFfprobe(json: unknown, maxDurationS: number = MAX_DURATION_S): Mp3Info {
  const r = ffprobeOut.safeParse(json)
  if (!r.success) throw new ProbeReject('ffprobe_unparseable')
  const { streams, format } = r.data
  if (format.format_name !== 'mp3') throw new ProbeReject('not_mp3')
  const audio = streams.filter((s) => s.codec_type === 'audio')
  if (audio.length !== 1 || audio[0]!.codec_name !== 'mp3') throw new ProbeReject('not_single_mp3_stream')
  const other = streams.filter((s) => s.codec_type !== 'audio')
  if (other.some((s) => s.codec_type !== 'video' || s.disposition?.attached_pic !== 1)) throw new ProbeReject('unexpected_streams')
  const durationS = Number(format.duration)
  if (!Number.isFinite(durationS)) throw new ProbeReject('no_duration')
  if (durationS < MIN_DURATION_S) throw new ProbeReject('too_short')
  if (durationS > maxDurationS) throw new ProbeReject('too_long')
  const bitrate = Number(audio[0]!.bit_rate ?? format.bit_rate)
  if (!Number.isFinite(bitrate) || bitrate < MIN_BITRATE) throw new ProbeReject('bitrate_too_low')
  const sampleRate = Number(audio[0]!.sample_rate)
  const channels = audio[0]!.channels
  return {
    durationS,
    bitrate: Math.round(bitrate),
    sampleRate: Number.isInteger(sampleRate) && sampleRate > 0 ? sampleRate : null,
    channels: channels !== undefined && channels > 0 ? channels : null,
  }
}

// The frames the mp3 demuxer actually reads, counted over the WHOLE file
// (demux only, nothing decoded): the duration a decode would really produce.
// ffprobe's -show_format duration comes from the upload's own Xing / Info
// header when it has one, and a forged frame count there makes a long file
// look short; a file without one gets an estimate that trailing data inflates.
export function countFramesArgs(file: string): string[] {
  return [
    '-hide_banner',
    '-v', 'error',
    '-protocol_whitelist', 'file,pipe',
    '-f', 'mp3',
    '-threads', '1',
    '-count_packets',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=nb_read_packets,sample_rate',
    '-print_format', 'json',
    `file:${file}`,
  ]
}

const countOut = z.object({
  streams: z.array(z.object({ nb_read_packets: z.string().regex(/^\d{1,9}$/), sample_rate: z.string().regex(/^\d{1,6}$/) }).passthrough()).length(1),
})

// Counted duration in seconds: frames × samples per frame (1152 for MPEG-1
// Layer III, 576 for MPEG-2 / 2.5) / rate. The rate must be the one ffprobe
// reported for the stream. ~1.3 s for 62 MB on the test host.
export const COUNT_TIMEOUT_S = 60
export async function countedDurationS(file: string, work: string, sampleRate: number): Promise<number> {
  const fp = await runLimited('ffprobe', countFramesArgs(file), { timeoutS: COUNT_TIMEOUT_S, vmemKb: 524288, cwd: work, nice: CONVERT_NICE })
  if (fp.timedOut) throw new ProbeReject('ffprobe_timeout')
  if (fp.code !== 0) throw new ProbeReject('not_mp3')
  let parsed: unknown
  try {
    parsed = JSON.parse(fp.stdout.toString('utf8'))
  } catch {
    throw new ProbeReject('ffprobe_unparseable')
  }
  const r = countOut.safeParse(parsed)
  if (!r.success) throw new ProbeReject('ffprobe_unparseable')
  const s = r.data.streams[0]!
  if (Number(s.sample_rate) !== sampleRate) throw new ProbeReject('not_mp3')
  const frames = Number(s.nb_read_packets)
  return (frames * (sampleRate >= 32000 ? 1152 : 576)) / sampleRate
}

// ffprobe, forced mp3 demuxer, file/pipe protocols only, 1 thread, timeout
// 20 s, address-space limit; stdin is empty.
async function ffprobeMp3(file: string, work: string, maxDurationS: number = MAX_DURATION_S): Promise<Mp3Info> {
  const fp = await runLimited('ffprobe', ffprobeArgs(file), { timeoutS: 20, vmemKb: 524288, cwd: work })
  if (fp.timedOut) throw new ProbeReject('ffprobe_timeout')
  if (fp.code !== 0) throw new ProbeReject('not_mp3')
  let parsed: unknown
  try {
    parsed = JSON.parse(fp.stdout.toString('utf8'))
  } catch {
    throw new ProbeReject('ffprobe_unparseable')
  }
  return judgeFfprobe(parsed, maxDurationS)
}

const mmOut = z.object({
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  genre: z.string().nullable(),
  year: z.string().regex(/^\d{1,4}$/).nullable().optional(),
  cover: z.object({ format: z.string(), size: z.number() }).nullable(),
})
type MmOut = z.infer<typeof mmOut>

// music-metadata in its own heap-capped child. The parser is chosen by the
// copy's extension (in.mp3 / in.wav), i.e. by the type the magic bytes chose.
async function readTags(copy: string, work: string, dirs: ProbeDirs): Promise<MmOut> {
  const mm = await runLimited('node', ['--max-old-space-size=64', dirs.mmChild, copy, join(work, 'cover.raw')], {
    timeoutS: 20,
    vmemKb: 4 * 1024 * 1024,
    cwd: work,
    maxStdout: 64 * 1024,
  })
  if (mm.code !== 0) throw new ProbeReject(mm.timedOut ? 'metadata_timeout' : 'metadata_unparseable')
  try {
    return mmOut.parse(JSON.parse(mm.stdout.toString('utf8')))
  } catch {
    throw new ProbeReject('metadata_unparseable')
  }
}

type Cover = { file: string; sha256: string; width: number; height: number }
type Job = { req: ProbeRequest; dirs: ProbeDirs; work: string; publishedCover: string | null }

// Cover → JPEG ≤1000 px, published next to the upload for preview.
async function publishCover(job: Job, tags: MmOut, flags: string[]): Promise<Cover | null> {
  if (!tags.cover) return null
  const rawCover = join(job.work, 'cover.raw')
  const raw = await readFile(rawCover)
  const out = join(job.work, 'cover.jpg')
  const ok = await reencodeCover(rawCover, raw, job.work, out)
  if (ok) {
    const jpg = await readFile(out)
    const d = imageDims(jpg, 'jpeg')
    if (d && d.w <= 1000 && d.h <= 1000 && jpg[0] === 0xff && jpg[1] === 0xd8) {
      const file = `cover-${job.req.id}.jpg`
      await publishFile(out, job.dirs.uploads, file)
      job.publishedCover = file
      return { file, sha256: await sha256File(out), width: d.w, height: d.h }
    }
  }
  flags.push('cover_dropped')
  return null
}

const tagsOf = (t: MmOut) => ({ title: t.title, artist: t.artist, album: t.album, genre: t.genre, year: t.year ?? null })

// The MPEG sample rates an MP3 may have (MPEG-1, -2, -2.5).
const MP3_RATES = new Set([48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000])

async function probeMp3(job: Job, copy: string, sha256: string, size: number): Promise<SpoolResult> {
  const read = reader(copy)
  // 1. magic bytes, then the MP3 input cap (the upload may have been
  //    declared a WAV, which the web allows up to 250 MB)
  const magic = await checkMp3Magic(read, size)
  if (!magic.ok) throw new ProbeReject(magic.reason)
  const cap = Math.min(job.req.maxMp3Bytes ?? MAX_MP3_UPLOAD_BYTES, MAX_MP3_UPLOAD_BYTES)
  if (size > cap) throw new ProbeReject('mp3_too_large')
  // 2. ID3v2: declared size ≤ 5 MB, no compressed/encrypted frames
  if (magic.id3Size > 0) {
    if (magic.id3Size > MAX_TAG_BYTES) throw new ProbeReject('id3_too_large')
    const v = scanId3(await read(0, magic.id3Size), magic.id3Size)
    if (!v.ok) throw new ProbeReject(v.reason)
  }
  // 3. ffprobe (bounds the duration BEFORE anything decodes the audio)
  const info = await ffprobeMp3(copy, job.work)
  // 4. music-metadata: tags and cover always come from the ORIGINAL file
  const tags = await readTags(copy, job.work, job.dirs)
  const flags: string[] = []
  // 5. an MP3 that already fits stays exactly as uploaded (no re-encode)
  if (mp3FitsUntouched(size, magic.id3Size)) {
    const cover = await publishCover(job, tags, flags)
    return {
      v: 1,
      id: job.req.id,
      type: 'probe',
      source: 'in-web',
      ok: true,
      sha256,
      size,
      durationS: Math.round(info.durationS * 10) / 10,
      bitrate: info.bitrate,
      tags: tagsOf(tags),
      cover,
      flags,
      inputFormat: 'mp3',
    }
  }
  // 6. too big: re-encode (transcode.ts) at the highest ladder rate that fits.
  //    The duration that picks the rate (and bounds the decode) is COUNTED
  //    from the frames the demuxer reads, not taken from the upload's own
  //    header: a forged Xing frame count would otherwise pass a 40-min file
  //    as 10 min into a decode that only the -t cap stops, and trailing data
  //    would inflate the estimate of a file without one.
  if (info.sampleRate === null || !MP3_RATES.has(info.sampleRate) || info.channels === null || info.channels > 2) throw new ProbeReject('not_mp3')
  const durationS = await countedDurationS(copy, job.work, info.sampleRate)
  if (durationS < MIN_DURATION_S) throw new ProbeReject('too_short')
  const bitrate = pickBitrate(durationS)
  if (bitrate === null) throw new ProbeReject('too_long')
  const out = join(job.work, 'out.mp3')
  const c = await runLimited('ffmpeg', mp3TranscodeArgs(copy, out, { sampleRate: info.sampleRate, channels: info.channels }, bitrate), {
    timeoutS: CONVERT_TIMEOUT_S,
    vmemKb: CONVERT_VMEM_KB,
    cwd: job.work,
    nice: CONVERT_NICE,
  })
  if (c.timedOut) throw new ProbeReject('reencode_timeout')
  if (c.code !== 0) throw new ProbeReject('reencode_failed')
  // 7. the MP3 must pass as an upload would, at the chosen rate, and as long
  //    as the original's counted frames (the encoder's delay / padding
  //    frames and a resample shift it a little, hence the tolerance)
  const tolerance = Math.max(2, durationS * 0.02)
  const enc = await checkEncoded(job, out, bitrate, durationS, tolerance, { tooLarge: 'reencoded_too_large', invalid: 'reencode_invalid' })
  // 8. the MP3 replaces the original under the same upload id
  const outSha = await publishEncoded(job, out)
  // 9. cover (from the original's tags), last
  flags.push('reencoded_to_fit')
  const cover = await publishCover(job, tags, flags)
  return {
    v: 1,
    id: job.req.id,
    type: 'probe',
    source: 'in-web',
    ok: true,
    sha256: outSha,
    size: enc.size,
    durationS: Math.round(enc.durationS * 10) / 10,
    bitrate: enc.bitrate,
    tags: tagsOf(tags),
    cover,
    flags,
    inputFormat: 'mp3',
    transcodeKbps: bitrate / 1000,
  }
}

// The probe's own encoder output (WAV conversion or MP3 re-encode) must fit
// the audio budget and pass every check an uploaded MP3 passes, at exactly
// the chosen CBR rate, and last as long as its source (± toleranceS).
async function checkEncoded(
  job: Job,
  out: string,
  bitrate: number,
  sourceDurationS: number,
  toleranceS: number,
  codes: { tooLarge: string; invalid: string },
): Promise<{ size: number; durationS: number; bitrate: number }> {
  const size = (await stat(out)).size
  if (size > AUDIO_BUDGET_BYTES) throw new ProbeReject(codes.tooLarge)
  const m = await checkMp3Magic(reader(out), size)
  if (!m.ok || m.id3Size !== 0) throw new ProbeReject(codes.invalid)
  let mp3: Mp3Info
  try {
    mp3 = await ffprobeMp3(out, job.work, MAX_DURATION_S + 5)
  } catch {
    throw new ProbeReject(codes.invalid)
  }
  if (mp3.bitrate !== bitrate || Math.abs(mp3.durationS - sourceDurationS) > toleranceS) throw new ProbeReject(codes.invalid)
  return { size, durationS: mp3.durationS, bitrate: mp3.bitrate }
}

// The encoded MP3 replaces the upload under the same id (tmp + rename), so
// preview, finalize and retention need no change; the original's bytes are
// freed here and released from the quota by the worker.
async function publishEncoded(job: Job, out: string): Promise<string> {
  const sha256 = await sha256File(out)
  await publishFile(out, job.dirs.uploads, job.req.upload)
  if ((await sha256File(join(job.dirs.uploads, job.req.upload))) !== sha256) throw new ProbeReject('publish_mismatch')
  return sha256
}

// ffmpeg's ID3v2 reader (ff_id3v2_match) takes these 10 bytes for another tag.
function looksLikeId3Header(b: Buffer): boolean {
  return b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b[3] !== 0xff && b[4] !== 0xff && ((b[6]! | b[7]! | b[8]! | b[9]!) & 0x80) === 0
}

// The WAV's 'id3 ' chunk gets the MP3 tag's pre-scan before music-metadata.
//
// ffmpeg reads the chunk with its ID3v2 reader, which does not stop at the
// first tag: it takes the next 10 bytes after each tag and parses another
// tag whenever they look like an ID3 header (a header with an unsupported
// version is skipped by its declared length and the loop goes on, so a
// following chunk named "ID3x", or a pad byte 'I' in front of one named
// "D3xx", could chain to an unscanned tag). So only ONE tag is allowed: the
// rest of the chunk must be zero padding, and the bytes where ffmpeg looks
// for a next tag (right after the tag, and after its v2.4 footer) must not
// look like an ID3 header, wherever they are in the file.
async function checkWavId3(read: (o: number, l: number) => Promise<Buffer>, info: WavInfo): Promise<void> {
  if (!info.id3) return
  const buf = await read(info.id3.offset, info.id3.size)
  if (buf.length < info.id3.size) throw new ProbeReject('wav_truncated')
  const declared = id3v2TagSize(buf)
  if (declared === null) throw new ProbeReject('wav_bad_id3')
  if (declared === -1) throw new ProbeReject('bad_id3_header')
  if (declared > buf.length) throw new ProbeReject('wav_bad_id3')
  const v = scanId3(buf, declared)
  if (!v.ok) throw new ProbeReject(v.reason)
  if (!buf.subarray(declared).every((b) => b === 0)) throw new ProbeReject('wav_bad_id3')
  const body = declared - (buf[3] === 4 && buf[5]! & 0x10 ? 10 : 0) // without a v2.4 footer
  for (const at of new Set([body, declared])) {
    if (looksLikeId3Header(await read(info.id3.offset + at, 10))) throw new ProbeReject('wav_bad_id3')
  }
}

async function probeWav(job: Job, copy: string, size: number): Promise<SpoolResult> {
  const cap = Math.min(job.req.maxWavBytes ?? MAX_WAV_UPLOAD_BYTES, MAX_WAV_UPLOAD_BYTES)
  if (size > cap) throw new ProbeReject('wav_too_large')
  const read = reader(copy)
  // 1–2. bounded RIFF walk + fmt rules, then the id3 chunk pre-scan
  const info = await scanWav(read, size)
  await checkWavId3(read, info)
  // 3. ffprobe -f wav must agree with the header
  const fp = await runLimited('ffprobe', wavFfprobeArgs(copy), { timeoutS: 20, vmemKb: 524288, cwd: job.work })
  if (fp.timedOut) throw new ProbeReject('ffprobe_timeout')
  if (fp.code !== 0) throw new ProbeReject('not_wav')
  let parsed: unknown
  try {
    parsed = JSON.parse(fp.stdout.toString('utf8'))
  } catch {
    throw new ProbeReject('ffprobe_unparseable')
  }
  const wav = judgeWavFfprobe(parsed, info)
  // 4. LIST/INFO + id3 chunk tags (and APIC) via music-metadata
  const tags = await readTags(copy, job.work, job.dirs)
  // 5. convert (nice 19, prlimit, timeout, own process group) at the
  //    highest ladder rate whose MP3 fits (v0.3.2; scanWav and
  //    judgeWavFfprobe bounded the duration, so the floor always fits)
  const bitrate = pickBitrate(Math.max(wav.durationS, info.durationS))
  if (bitrate === null) throw new ProbeReject('wav_too_long')
  const out = join(job.work, 'out.mp3')
  const c = await runLimited('ffmpeg', convertArgs(copy, out, info.fmt, bitrate), {
    timeoutS: CONVERT_TIMEOUT_S,
    vmemKb: CONVERT_VMEM_KB,
    cwd: job.work,
    nice: CONVERT_NICE,
  })
  if (c.timedOut) throw new ProbeReject('convert_timeout')
  if (c.code !== 0) throw new ProbeReject('convert_failed')
  // 6. the MP3 must pass as an upload would (chosen rate, ±1 s, ≤ budget)
  const mp3 = await checkEncoded(job, out, bitrate, wav.durationS, 1, { tooLarge: 'converted_too_large', invalid: 'convert_invalid' })
  // 7. the MP3 replaces the WAV under the same upload id (the WAV's bytes
  //    are freed here and released from the quota by the worker)
  const sha256 = await publishEncoded(job, out)
  // 8. cover, last (a rejection above never leaves one behind)
  const flags: string[] = ['converted_from_wav']
  const cover = await publishCover(job, tags, flags)
  return {
    v: 1,
    id: job.req.id,
    type: 'probe',
    source: 'in-web',
    ok: true,
    sha256,
    size: mp3.size,
    durationS: Math.round(mp3.durationS * 10) / 10,
    bitrate: mp3.bitrate,
    tags: tagsOf(tags),
    cover,
    flags,
    inputFormat: 'wav',
    transcodeKbps: bitrate / 1000,
  }
}

// unlink never follows a symlink; the name is schema-checked (32 hex).
export async function releaseUpload(uploadsDir: string, upload: string): Promise<boolean> {
  try {
    await unlink(join(uploadsDir, upload))
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export async function runProbe(req: ProbeRequest, dirs: ProbeDirs): Promise<SpoolResult> {
  const work = await mkdtemp(join(dirs.work, `p-${req.id}-`))
  const job: Job = { req, dirs, work, publishedCover: null }
  try {
    // sha256 of the exact bytes every later step (and the reviewer's
    // preview) is about; the parsers get this private copy read-only, in a
    // per-job work dir.
    const raw = join(work, 'in.raw')
    const { sha256, size } = await copyNoFollowHashed(join(dirs.uploads, req.upload), raw, MAX_PROBE_INPUT_BYTES, req.expectedSize)
    const kind = sniffWav(await reader(raw)(0, 12))
    if (kind === 'rf64') throw new ProbeReject('wav_rf64_unsupported')
    if (kind === 'rifx') throw new ProbeReject('wav_unsupported')
    const copy = join(work, kind === 'wav' ? 'in.wav' : 'in.mp3')
    await rename(raw, copy)
    await chmod(copy, 0o400)
    return kind === 'wav' ? await probeWav(job, copy, size) : await probeMp3(job, copy, sha256, size)
  } catch (e) {
    if (job.publishedCover) await unlink(join(dirs.uploads, job.publishedCover)).catch(() => {})
    const released = await releaseUpload(dirs.uploads, req.upload)
    return { v: 1, id: req.id, type: 'probe', source: 'in-web', ok: false, error: e instanceof ProbeReject ? e.code : 'probe_failed', released }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
