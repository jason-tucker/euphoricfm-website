// 'probe' requests (from in-web only): plan §3.4 steps 1–6.

import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { MAX_UPLOAD_BYTES, type ProbeRequest, type SpoolResult } from '../server/spool/protocol'
import { imageDims, reencodeCover } from './cover'
import { runLimited } from './exec'
import { copyNoFollowHashed, ProbeReject, publishFile, reader, sha256File } from './files'
import { MAX_TAG_BYTES, scanId3 } from './id3scan'
import { checkMp3Magic } from './magic'

export type ProbeDirs = { uploads: string; work: string; mmChild: string }

export const MIN_DURATION_S = 30
export const MAX_DURATION_S = 20 * 60
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
        disposition: z.object({ attached_pic: z.number().optional() }).passthrough().optional(),
      })
      .passthrough(),
  ),
  format: z.object({ format_name: z.string(), duration: z.string().optional(), bit_rate: z.string().optional() }).passthrough(),
})

export function judgeFfprobe(json: unknown): { durationS: number; bitrate: number } {
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
  if (durationS > MAX_DURATION_S) throw new ProbeReject('too_long')
  const bitrate = Number(audio[0]!.bit_rate ?? format.bit_rate)
  if (!Number.isFinite(bitrate) || bitrate < MIN_BITRATE) throw new ProbeReject('bitrate_too_low')
  return { durationS, bitrate: Math.round(bitrate) }
}

export async function runProbe(req: ProbeRequest, dirs: ProbeDirs): Promise<SpoolResult> {
  const work = await mkdtemp(join(dirs.work, `p-${req.id}-`))
  const base = { v: 1 as const, id: req.id, type: 'probe' as const, source: 'in-web' as const }
  try {
    const copy = join(work, 'in.mp3')
    // 6. sha256 of the exact bytes every later step (and the reviewer's
    //    preview) is about.
    const { sha256, size } = await copyNoFollowHashed(join(dirs.uploads, req.upload), copy, MAX_UPLOAD_BYTES, req.expectedSize)
    // The parsers get this private copy read-only, in a per-job work dir.
    await chmod(copy, 0o400)
    const read = reader(copy)

    // 1. magic bytes
    const magic = await checkMp3Magic(read, size)
    if (!magic.ok) throw new ProbeReject(magic.reason)

    // 2. ID3v2: declared size ≤ 5 MB, no compressed/encrypted frames
    if (magic.id3Size > 0) {
      if (magic.id3Size > MAX_TAG_BYTES) throw new ProbeReject('id3_too_large')
      const v = scanId3(await read(0, magic.id3Size), magic.id3Size)
      if (!v.ok) throw new ProbeReject(v.reason)
    }

    // 3. ffprobe, forced mp3 demuxer, file/pipe protocols only, 1 thread,
    //    timeout 20 s, ulimit -v; stdin is /dev/null.
    const fp = await runLimited('ffprobe', ffprobeArgs(copy), { timeoutS: 20, vmemKb: 524288, cwd: work })
    if (fp.timedOut) throw new ProbeReject('ffprobe_timeout')
    if (fp.code !== 0) throw new ProbeReject('not_mp3')
    let parsed: unknown
    try {
      parsed = JSON.parse(fp.stdout.toString('utf8'))
    } catch {
      throw new ProbeReject('ffprobe_unparseable')
    }
    const { durationS, bitrate } = judgeFfprobe(parsed)

    // 4. music-metadata in its own heap-capped child.
    const rawCover = join(work, 'cover.raw')
    const mm = await runLimited('node', ['--max-old-space-size=64', dirs.mmChild, copy, rawCover], {
      timeoutS: 20,
      vmemKb: 4 * 1024 * 1024,
      cwd: work,
      maxStdout: 64 * 1024,
    })
    if (mm.code !== 0) throw new ProbeReject(mm.timedOut ? 'metadata_timeout' : 'metadata_unparseable')
    const tags = z
      .object({
        title: z.string().nullable(),
        artist: z.string().nullable(),
        album: z.string().nullable(),
        genre: z.string().nullable(),
        year: z.string().regex(/^\d{1,4}$/).nullable().optional(),
        cover: z.object({ format: z.string(), size: z.number() }).nullable(),
      })
      .parse(JSON.parse(mm.stdout.toString('utf8')))

    // 5. cover → JPEG ≤1000 px, published next to the upload for preview.
    const flags: string[] = []
    let cover: { file: string; sha256: string; width: number; height: number } | null = null
    if (tags.cover) {
      const raw = await readFile(rawCover)
      const out = join(work, 'cover.jpg')
      const ok = await reencodeCover(rawCover, raw, work, out)
      if (ok) {
        const jpg = await readFile(out)
        const d = imageDims(jpg, 'jpeg')
        if (d && d.w <= 1000 && d.h <= 1000 && jpg[0] === 0xff && jpg[1] === 0xd8) {
          const file = `cover-${req.id}.jpg`
          await publishFile(out, dirs.uploads, file)
          cover = { file, sha256: await sha256File(out), width: d.w, height: d.h }
        } else flags.push('cover_dropped')
      } else flags.push('cover_dropped')
    }

    return {
      ...base,
      ok: true,
      sha256,
      size,
      durationS: Math.round(durationS * 10) / 10,
      bitrate,
      tags: { title: tags.title, artist: tags.artist, album: tags.album, genre: tags.genre, year: tags.year ?? null },
      cover,
      flags,
    }
  } catch (e) {
    if (e instanceof ProbeReject) return { ...base, ok: false, error: e.code }
    return { ...base, ok: false, error: 'probe_failed' }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
