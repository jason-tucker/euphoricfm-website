// 'probe_fetch' requests (v0.4.0, P5; from in-worker only): a song music-fetch
// downloaded from SoundCloud becomes an MP3 the rest of the portal treats
// like an upload (/staging/uploads/<upload>: preview, finalize, retention).
//
// music-fetch is the only container with internet egress, so what it wrote
// is untrusted input. It is handled like an upload, and more narrowly:
//   1. the path is built here from the request's fetch id and extension
//      (/staging/fetch/<fetchId>/audio.<ext>, mounted READ-ONLY); the file is
//      copied once, without following links, into a private work dir, and
//      its size and sha256 must be the ones music-fetch reported;
//   2. ONLY the formats yt-dlp returns for SoundCloud are decoded: AAC in MP4
//      / M4A, Opus in Ogg, MP3. The container is checked by magic bytes here
//      again (music-fetch's check is not trusted), the extension must match
//      it, and the demuxer is FORCED (-f mp4 | ogg | mp3; for MP4 also
//      -enable_drefs 0, so no external data reference is followed);
//   3. ffprobe and ffmpeg read with -protocol_whitelist file only (never
//      pipe: an HLS playlist or a data reference can never cause a read of
//      anything else; the probe has no network anyway), one thread, under
//      prlimit (address space, no core) + timeout, in their own process
//      group, argv only (exec.ts runLimited), and ffmpeg at nice 19, exactly
//      like the WAV conversion and the fit re-encode;
//   4. ffprobe must see exactly ONE audio stream of the expected codec and
//      nothing else, 30 s to 24 min (src/lib/fit.ts MAX_DURATION_S);
//   5. AAC / Opus are decoded with a forced decoder (-c:a aac | opus), every
//      non-audio stream dropped at the demuxer, -t and -fs capped, and encoded
//      to CBR MP3 at the highest fit-ladder rate that fits (the rate is chosen
//      from the LONGER of ffprobe's duration and SoundCloud's own); the MP3
//      must then pass every check an uploaded MP3 passes at exactly that rate,
//      and last as long as its source;
//   6. an MP3 goes through the upload checks (magic, ID3 pre-scan, ffprobe -f
//      mp3, ≥128 kbps) and, when it already fits, is kept byte for byte;
//      otherwise it takes the fit re-encode (duration counted from frames);
//   7. artwork.raw (optional) takes the standalone album-art path: size and
//      sha256 as reported, JPEG / PNG / WebP by magic bytes only (never SVG or
//      GIF), header dimensions bounded and the file complete before the
//      decoder runs, re-encoded to a JPEG ≤1000 px (cover.ts). A bad cover is
//      dropped (flagged), never fatal.
// The raw download is never modified here (the mount is read-only): the
// worker asks music-fetch to delete it once this result is collected.

import { chmod, lstat, mkdtemp, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AUDIO_BUDGET_BYTES, MAX_DURATION_S, mp3FitsUntouched, pickBitrate } from '../lib/fit'
import { FETCH_PROBE_FORMATS, MAX_ART_BYTES, MAX_FETCH_INPUT_BYTES, type ProbeFetchRequest, type SpoolResult } from '../server/spool/protocol'
import { ART_KINDS } from './art'
import { dimsAcceptable, imageComplete, imageDims, reencodeCover, sniffImage } from './cover'
import { runLimited } from './exec'
import { copyNoFollowHashed, ProbeReject, publishFile, reader, sha256File } from './files'
import { MAX_TAG_BYTES, scanId3 } from './id3scan'
import { checkMp3Magic } from './magic'
import { checkEncoded, countedDurationS, ffprobeMp3, MIN_DURATION_S, MP3_RATES, publishEncoded } from './probe'
import { mp3TargetRate, mp3TranscodeArgs } from './transcode'
import { CONVERT_NICE, CONVERT_TIMEOUT_S, CONVERT_VMEM_KB } from './wav'

export type FetchedDirs = { fetch: string; uploads: string; work: string }
type Format = 'mp4' | 'ogg' | 'mp3'
type Codec = 'aac' | 'opus' | 'mp3'

const CODEC: Record<Format, Codec> = { mp4: 'aac', ogg: 'opus', mp3: 'mp3' }
// The native ffmpeg decoder forced for each codec.
const DECODER: Record<Exclude<Codec, 'mp3'>, string> = { aac: 'aac', opus: 'opus' }
const WL = 'file' as const

// Container by magic bytes (the probe's own check; music-fetch's is not trusted).
export function sniffFetched(head: Buffer): Format | null {
  // ISO BMFF: the first box is ftyp (music-fetch's fragmented MP4 starts with
  // the init segment's ftyp + moov).
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') return 'mp4'
  // Ogg: the first page carries the Opus identification header.
  if (head.length >= 36 && head.toString('latin1', 0, 4) === 'OggS' && head.subarray(0, 64).includes(Buffer.from('OpusHead'))) return 'ogg'
  if (head.length >= 3 && head.toString('latin1', 0, 3) === 'ID3') return 'mp3'
  if (head.length >= 4 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3'
  return null
}

const demuxOpts = (format: Format): string[] => (format === 'mp4' ? ['-enable_drefs', '0'] : [])

export function fetchedFfprobeArgs(file: string, format: Exclude<Format, 'mp3'>): string[] {
  return [
    '-hide_banner',
    '-v', 'error',
    '-protocol_whitelist', WL,
    ...demuxOpts(format),
    '-f', format,
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
        sample_rate: z.string().optional(),
        channels: z.number().int().optional(),
        duration: z.string().optional(),
      })
      .passthrough(),
  ),
  format: z.object({ format_name: z.string(), duration: z.string().optional() }).passthrough(),
})

export type FetchedInfo = { durationS: number; sampleRate: number; channels: number }

export function judgeFetchedFfprobe(json: unknown, format: Exclude<Format, 'mp3'>): FetchedInfo {
  const r = ffprobeOut.safeParse(json)
  if (!r.success) throw new ProbeReject('ffprobe_unparseable')
  const { streams, format: f } = r.data
  // ffprobe names the mp4 demuxer "mov,mp4,m4a,3gp,3g2,mj2"
  if (format === 'mp4' ? !f.format_name.split(',').includes('mp4') : f.format_name !== 'ogg') throw new ProbeReject('sc_format_mismatch')
  if (streams.length !== 1 || streams[0]!.codec_type !== 'audio') throw new ProbeReject('sc_unexpected_streams')
  const a = streams[0]!
  if (a.codec_name !== CODEC[format]) throw new ProbeReject('sc_codec_unsupported')
  const sampleRate = Number(a.sample_rate)
  const channels = a.channels ?? 0
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96_000) throw new ProbeReject('sc_bad_media')
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new ProbeReject('sc_bad_media')
  const durationS = Number(f.duration ?? a.duration)
  if (!Number.isFinite(durationS) || durationS <= 0) throw new ProbeReject('no_duration')
  if (durationS < MIN_DURATION_S) throw new ProbeReject('too_short')
  if (durationS > MAX_DURATION_S) throw new ProbeReject('too_long')
  return { durationS, sampleRate, channels }
}

export function fetchedTranscodeArgs(input: string, output: string, format: Exclude<Format, 'mp3'>, src: { sampleRate: number; channels: number }, bitrate: number): string[] {
  if (!Number.isInteger(bitrate) || bitrate < 8000 || bitrate > 320_000 || bitrate % 1000 !== 0) throw new Error('fetchedTranscodeArgs: bad bitrate')
  const rate = mp3TargetRate(src.sampleRate)
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-protocol_whitelist', WL,
    '-threads', '1',
    '-filter_threads', '1',
    ...demuxOpts(format),
    '-vn', '-sn', '-dn',
    '-c:a', DECODER[CODEC[format] as Exclude<Codec, 'mp3'>],
    '-f', format, '-i', `file:${input}`,
    '-map', '0:a:0',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-vn', '-sn', '-dn',
    ...(src.channels > 2 ? ['-ac', '2'] : []),
    ...(rate !== src.sampleRate ? ['-ar', String(rate)] : []),
    '-t', String(MAX_DURATION_S + 5),
    '-fs', String(AUDIO_BUDGET_BYTES + 1),
    '-c:a', 'libmp3lame',
    '-b:a', `${bitrate / 1000}k`,
    '-threads', '1',
    '-id3v2_version', '0',
    '-write_id3v1', '0',
    '-f', 'mp3',
    `file:${output}`,
  ]
}

type Cover = { file: string; sha256: string; width: number; height: number }
type Job = { req: ProbeFetchRequest; dirs: FetchedDirs; work: string; publishedAudio: boolean; publishedCover: string | null }
type Encoded = { sha256: string; size: number; durationS: number; bitrate: number; inputFormat: Codec; transcodeKbps?: number }

async function encodeTo(job: Job, args: string[], bitrate: number, sourceDurationS: number, inputFormat: Codec): Promise<Encoded> {
  const out = args[args.length - 1]!.replace(/^file:/, '')
  const c = await runLimited('ffmpeg', args, { timeoutS: CONVERT_TIMEOUT_S, vmemKb: CONVERT_VMEM_KB, cwd: job.work, nice: CONVERT_NICE })
  if (c.timedOut) throw new ProbeReject('sc_convert_timeout')
  if (c.code !== 0) throw new ProbeReject('sc_decode_failed')
  const tolerance = Math.max(2, sourceDurationS * 0.02)
  const enc = await checkEncoded(job, out, bitrate, sourceDurationS, tolerance, { tooLarge: 'sc_converted_too_large', invalid: 'sc_convert_invalid' })
  if (enc.durationS < MIN_DURATION_S) throw new ProbeReject('too_short')
  const sha256 = await publishEncoded(job, out)
  job.publishedAudio = true
  return { sha256, size: enc.size, durationS: enc.durationS, bitrate: enc.bitrate, inputFormat, transcodeKbps: bitrate / 1000 }
}

async function convertAacOpus(job: Job, copy: string, format: Exclude<Format, 'mp3'>): Promise<Encoded> {
  const fp = await runLimited('ffprobe', fetchedFfprobeArgs(copy, format), { timeoutS: 20, vmemKb: 524288, cwd: job.work })
  if (fp.timedOut) throw new ProbeReject('ffprobe_timeout')
  if (fp.code !== 0) throw new ProbeReject('sc_bad_media')
  let parsed: unknown
  try {
    parsed = JSON.parse(fp.stdout.toString('utf8'))
  } catch {
    throw new ProbeReject('ffprobe_unparseable')
  }
  const info = judgeFetchedFfprobe(parsed, format)
  const bitrate = pickBitrate(Math.max(info.durationS, job.req.declaredDurationS))
  if (bitrate === null) throw new ProbeReject('too_long')
  return encodeTo(job, fetchedTranscodeArgs(copy, join(job.work, 'out.mp3'), format, info, bitrate), bitrate, info.durationS, CODEC[format])
}

async function convertMp3(job: Job, copy: string, size: number): Promise<Encoded> {
  const read = reader(copy)
  const magic = await checkMp3Magic(read, size)
  if (!magic.ok) throw new ProbeReject(magic.reason)
  if (magic.id3Size > 0) {
    if (magic.id3Size > MAX_TAG_BYTES) throw new ProbeReject('id3_too_large')
    const v = scanId3(await read(0, magic.id3Size), magic.id3Size)
    if (!v.ok) throw new ProbeReject(v.reason)
  }
  const info = await ffprobeMp3(copy, job.work, MAX_DURATION_S, WL)
  if (mp3FitsUntouched(size, magic.id3Size) && info.durationS >= MIN_DURATION_S) {
    // Kept byte for byte (finalize strips the ID3 tag and writes the portal's).
    const sha256 = await publishEncoded(job, copy)
    job.publishedAudio = true
    return { sha256, size, durationS: info.durationS, bitrate: info.bitrate, inputFormat: 'mp3' }
  }
  if (info.sampleRate === null || !MP3_RATES.has(info.sampleRate) || info.channels === null || info.channels > 2) throw new ProbeReject('not_mp3')
  const durationS = await countedDurationS(copy, job.work, info.sampleRate, WL)
  if (durationS < MIN_DURATION_S) throw new ProbeReject('too_short')
  const bitrate = pickBitrate(Math.max(durationS, job.req.declaredDurationS))
  if (bitrate === null) throw new ProbeReject('too_long')
  const args = mp3TranscodeArgs(copy, join(job.work, 'out.mp3'), { sampleRate: info.sampleRate, channels: info.channels }, bitrate, WL)
  return encodeTo(job, args, bitrate, durationS, 'mp3')
}

// The job directory itself must be a real directory, not a link music-fetch
// could have planted to point the probe elsewhere (the files in it are opened
// with O_NOFOLLOW, and their sha256 must be the reported one).
async function assertJobDir(dirs: FetchedDirs, fetchId: string): Promise<void> {
  const st = await lstat(join(dirs.fetch, fetchId)).catch(() => null)
  if (!st || !st.isDirectory()) throw new ProbeReject('input_missing')
}

// The album-art path (art.ts) for artwork.raw; any problem drops the cover.
async function publishFetchedCover(job: Job, flags: string[]): Promise<Cover | null> {
  if (!job.req.artworkSha256) return null
  try {
    await assertJobDir(job.dirs, job.req.fetchId)
    const raw = join(job.work, 'art.raw')
    const { sha256 } = await copyNoFollowHashed(join(job.dirs.fetch, job.req.fetchId, 'artwork.raw'), raw, MAX_ART_BYTES)
    if (sha256 !== job.req.artworkSha256) throw new ProbeReject('cover_hash_mismatch')
    await chmod(raw, 0o400)
    const bytes = await readFile(raw)
    const kind = sniffImage(bytes)
    if (!kind || !ART_KINDS.has(kind)) throw new ProbeReject('cover_type')
    if (!dimsAcceptable(imageDims(bytes, kind)) || !imageComplete(bytes, kind)) throw new ProbeReject('cover_header')
    const out = join(job.work, 'cover.jpg')
    if (!(await reencodeCover(raw, bytes, job.work, out))) throw new ProbeReject('cover_decode')
    const jpg = await readFile(out)
    const d = imageDims(jpg, 'jpeg')
    if (!d || d.w < 1 || d.h < 1 || d.w > 1000 || d.h > 1000 || sniffImage(jpg) !== 'jpeg') throw new ProbeReject('cover_decode')
    const file = `cover-${job.req.id}.jpg`
    await publishFile(out, job.dirs.uploads, file)
    job.publishedCover = file
    return { file, sha256: await sha256File(out), width: d.w, height: d.h }
  } catch (e) {
    flags.push(e instanceof ProbeReject ? e.code : 'cover_dropped')
    return null
  }
}

export async function runProbeFetch(req: ProbeFetchRequest, dirs: FetchedDirs): Promise<SpoolResult> {
  const base = { v: 1 as const, id: req.id, type: 'probe_fetch' as const, source: 'in-worker' as const }
  const work = await mkdtemp(join(dirs.work, `s-${req.id}-`))
  const job: Job = { req, dirs, work, publishedAudio: false, publishedCover: null }
  try {
    if (FETCH_PROBE_FORMATS[req.ext] !== req.format) throw new ProbeReject('sc_format_mismatch')
    const raw = join(work, 'in.raw')
    await assertJobDir(dirs, req.fetchId)
    const { sha256, size } = await copyNoFollowHashed(join(dirs.fetch, req.fetchId, `audio.${req.ext}`), raw, MAX_FETCH_INPUT_BYTES, req.size)
    if (sha256 !== req.sha256) throw new ProbeReject('sc_hash_mismatch')
    const format = sniffFetched(await reader(raw)(0, 64))
    if (format !== req.format) throw new ProbeReject('sc_format_mismatch')
    const copy = join(work, `in.${format === 'mp3' ? 'mp3' : format === 'mp4' ? 'm4a' : 'ogg'}`)
    await rename(raw, copy)
    await chmod(copy, 0o400)
    const enc = format === 'mp3' ? await convertMp3(job, copy, size) : await convertAacOpus(job, copy, format)
    // What was published is what was checked.
    if ((await stat(join(dirs.uploads, req.upload))).size !== enc.size) throw new ProbeReject('publish_mismatch')
    const flags: string[] = [enc.transcodeKbps ? `converted_from_${enc.inputFormat}` : 'kept_untouched']
    const cover = await publishFetchedCover(job, flags)
    return {
      ...base,
      ok: true,
      sha256: enc.sha256,
      size: enc.size,
      durationS: Math.round(enc.durationS * 10) / 10,
      bitrate: enc.bitrate,
      cover,
      flags,
      inputFormat: enc.inputFormat,
      ...(enc.transcodeKbps ? { transcodeKbps: enc.transcodeKbps } : {}),
    }
  } catch (e) {
    // Only what THIS job published is removed (a repeated request for the
    // same upload must never delete a song an earlier run published).
    if (job.publishedCover) await unlink(join(dirs.uploads, job.publishedCover)).catch(() => {})
    if (job.publishedAudio) await unlink(join(dirs.uploads, req.upload)).catch(() => {})
    return { ...base, ok: false, error: e instanceof ProbeReject ? e.code : 'probe_failed' }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
