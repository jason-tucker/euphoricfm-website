// Spool protocol between web / worker and the network-less music-probe
// (plan §3 "Spool" + the PINNED MOUNTS).
//
//   /spool/probe/in-web/<uuid>.json     written by web      → 'probe' | 'art' | 'art_release'
//   /spool/probe/in-worker/<uuid>.json  written by worker   → 'finalize' | 'cover' | 'probe_fetch' | 'cleanup_final'
//   /spool/probe/out/<uuid>.json        written by probe    → read-only for web + worker
//
// The mounts enforce who can write where; the probe additionally enforces
// which request TYPES each inbox may carry, and stamps every result with the
// inbox it came from, so a result can never be mistaken for another queue's.
// Requests and results are small JSON documents written atomically
// (exclusive tmp file + rename/link), never through a symlink.

import { constants as FS } from 'node:fs'
import { open, link, rename, unlink, readdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { MAX_MP3_UPLOAD_BYTES, MAX_UPLOAD_BYTES, MAX_WAV_UPLOAD_BYTES } from '../../lib/fit'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const UPLOAD_ID_RE = /^[0-9a-f]{32}$/
export const COVER_FILE_RE = /^cover-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/
export const SHA256_RE = /^[0-9a-f]{64}$/
// Every MP3 the probe leaves in /staging/uploads for finalize (an untouched
// upload, or one it converted from a WAV / re-encoded to fit, v0.3.5) is at
// most MAX_UPLOAD_BYTES, the final-file cap. The INPUTS are capped by type:
// an MP3 upload at most MAX_MP3_UPLOAD_BYTES (v0.3.5), a WAV upload at most
// MAX_WAV_UPLOAD_BYTES (v0.3.0). The web caps a tus upload by its DECLARED
// type; the probe caps it again by its ACTUAL type (magic bytes), so the
// effective limit is the stricter of the two. The numbers live in
// src/lib/fit.ts (shared with the UI texts).
export { MAX_MP3_UPLOAD_BYTES, MAX_UPLOAD_BYTES, MAX_WAV_UPLOAD_BYTES } from '../../lib/fit'
export const MAX_PROBE_INPUT_BYTES = Math.max(MAX_UPLOAD_BYTES, MAX_MP3_UPLOAD_BYTES, MAX_WAV_UPLOAD_BYTES)
export const MAX_SPOOL_DOC_BYTES = 64 * 1024
// Album art (art contract 2026-09-27): the web writes the raw upload to
// <art-in>/<artId>; the probe writes the re-encoded JPEG to
// <art>/<artId>/<ART_JPEG_FILE>. The art id doubles as the spool request id.
export const ART_JPEG_FILE = 'cover.jpg'
export const MAX_ART_BYTES = 5 * 1024 * 1024

export type Inbox = 'in-web' | 'in-worker'

export const INBOX_TYPES: Record<Inbox, readonly string[]> = {
  'in-web': ['probe', 'art', 'art_release'],
  'in-worker': ['finalize', 'cover', 'probe_fetch', 'cleanup_final'],
}

const tagString = z
  .string()
  .max(200)
  .refine((s) => !/[\p{Cc}]/u.test(s), 'control characters')

export const probeRequest = z
  .object({
    v: z.literal(1),
    id: z.string().regex(UUID_RE),
    type: z.literal('probe'),
    upload: z.string().regex(UPLOAD_ID_RE),
    expectedSize: z.number().int().min(1).max(MAX_PROBE_INPUT_BYTES),
    // The admin-lowered WAV cap at attach time (caps.maxWavUploadBytes); the
    // probe applies it to an actual WAV on top of MAX_WAV_UPLOAD_BYTES.
    // Optional so a request spooled by an older web still parses.
    maxWavBytes: z.number().int().min(1).max(MAX_WAV_UPLOAD_BYTES).optional(),
    // v0.3.5, the same for an actual MP3 (caps.maxMp3UploadBytes) on top of
    // MAX_MP3_UPLOAD_BYTES.
    maxMp3Bytes: z.number().int().min(1).max(MAX_MP3_UPLOAD_BYTES).optional(),
  })
  .strict()

// Custom album art (art contract 2026-09-27): the probe's re-encoded JPEG
// for art_uploads.id lives at /staging/art/<artId>/<ART_JPEG_FILE>. The
// request names only the id; the probe builds the path itself (the same
// path the art request published, see ART_JPEG_FILE above).

export const finalizeCover = z.union([
  z.object({ file: z.string().regex(COVER_FILE_RE), sha256: z.string().regex(SHA256_RE) }).strict(), // embedded (probe-time) cover
  z.object({ artId: z.string().regex(UUID_RE), sha256: z.string().regex(SHA256_RE) }).strict(), // custom art upload
])

export const finalizeRequest = z
  .object({
    v: z.literal(1),
    id: z.string().regex(UUID_RE),
    type: z.literal('finalize'),
    upload: z.string().regex(UPLOAD_ID_RE),
    approvedSha256: z.string().regex(SHA256_RE),
    tags: z.object({ title: tagString, artist: tagString, album: tagString, genre: tagString }).strict(),
    cover: finalizeCover.nullable(),
  })
  .strict()

// P5 (SoundCloud) request types: accepted by the schema so the inbox rules
// are complete, answered 'not_implemented' by the probe until P5.
export const coverRequest = z
  .object({ v: z.literal(1), id: z.string().regex(UUID_RE), type: z.literal('cover'), input: z.string().max(200) })
  .strict()
export const probeFetchRequest = z
  .object({ v: z.literal(1), id: z.string().regex(UUID_RE), type: z.literal('probe_fetch'), input: z.string().max(200) })
  .strict()

// A standalone album-art upload to re-encode (JPEG/PNG/WebP only).
export const artRequest = z
  .object({ v: z.literal(1), id: z.string().regex(UUID_RE), type: z.literal('art'), expectedSize: z.number().int().min(1).max(MAX_ART_BYTES) })
  .strict()
// Delete an expired art JPEG (the probe is the only writer of the art dir).
export const artReleaseRequest = z
  .object({ v: z.literal(1), id: z.string().regex(UUID_RE), type: z.literal('art_release'), artId: z.string().regex(UUID_RE) })
  .strict()

// P3: the worker mounts /staging/final read-only, so it asks the probe to
// remove a finalized file (live or failed + 7 days). Name pattern only.
export const FINAL_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp3$/
export const cleanupFinalRequest = z
  .object({ v: z.literal(1), id: z.string().regex(UUID_RE), type: z.literal('cleanup_final'), file: z.string().regex(FINAL_FILE_RE) })
  .strict()

export const spoolRequest = z.discriminatedUnion('type', [probeRequest, finalizeRequest, coverRequest, probeFetchRequest, artRequest, artReleaseRequest, cleanupFinalRequest])
export type SpoolRequest = z.infer<typeof spoolRequest>
export type ProbeRequest = z.infer<typeof probeRequest>
export type FinalizeRequest = z.infer<typeof finalizeRequest>
export type ArtRequest = z.infer<typeof artRequest>
export type ArtReleaseRequest = z.infer<typeof artReleaseRequest>

const resultBase = { v: z.literal(1), id: z.string().regex(UUID_RE), source: z.enum(['in-web', 'in-worker']) }

export const probeTags = z.object({
  title: z.string().max(200).nullable(),
  artist: z.string().max(200).nullable(),
  album: z.string().max(200).nullable(),
  genre: z.string().max(200).nullable(),
  // Prefill only (shown to the submitter); not written by finalize.
  year: z.string().regex(/^\d{1,4}$/).nullable().optional(),
})

export const probeOk = z.object({
  ...resultBase,
  type: z.literal('probe'),
  ok: z.literal(true),
  sha256: z.string().regex(SHA256_RE),
  size: z.number().int(),
  durationS: z.number(),
  bitrate: z.number().int(),
  tags: probeTags,
  cover: z.object({ file: z.string().regex(COVER_FILE_RE), sha256: z.string().regex(SHA256_RE), width: z.number().int(), height: z.number().int() }).nullable(),
  flags: z.array(z.string().max(64)).max(16),
  // v0.3.0: what the member uploaded. 'wav' = the probe converted it to a
  // CBR MP3 (320 kbps; since v0.3.5 the ladder rate in transcodeKbps), which
  // replaced the WAV under the same upload id; sha256 / size / durationS /
  // bitrate above describe that MP3. Optional: results written by an older
  // probe have no field (= mp3).
  inputFormat: z.enum(['mp3', 'wav']).optional(),
  // v0.3.5: set when the probe ENCODED the MP3 above (a WAV, or an MP3 too
  // big to fit the final-file cap): its CBR bitrate in kbps (320 / 256 / 192).
  // Absent = the upload is the member's own MP3, untouched.
  transcodeKbps: z.number().int().min(8).max(320).optional(),
})

export const finalizeOk = z.object({
  ...resultBase,
  type: z.literal('finalize'),
  ok: z.literal(true),
  file: z.string().regex(/^[0-9a-f-]{36}\.mp3$/),
  finalSha256: z.string().regex(SHA256_RE),
  size: z.number().int(),
})

export const artOk = z.object({
  ...resultBase,
  type: z.literal('art'),
  ok: z.literal(true),
  file: z.literal(ART_JPEG_FILE),
  sha256: z.string().regex(SHA256_RE),
  size: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
})

export const artReleaseOk = z.object({ ...resultBase, type: z.literal('art_release'), ok: z.literal(true), artId: z.string().regex(UUID_RE) })

export const spoolFailure = z.object({
  ...resultBase,
  type: z.string().max(32),
  ok: z.literal(false),
  error: z.string().max(64),
  // v0.3.0, 'probe' only: the probe deleted the rejected upload's bytes from
  // /staging/uploads, so the worker releases them from the staging quota.
  released: z.boolean().optional(),
})

export const cleanupOk = z.object({
  ...resultBase,
  type: z.literal('cleanup_final'),
  ok: z.literal(true),
  removed: z.boolean(),
})

export const spoolResult = z.union([probeOk, finalizeOk, artOk, artReleaseOk, cleanupOk, spoolFailure])
export type SpoolResult = z.infer<typeof spoolResult>

// Exclusive-create a tmp file (O_CREAT|O_EXCL never follows a symlink), then
// rename it into place.
async function writeExclusiveTmp(dir: string, data: string): Promise<string> {
  const tmp = join(dir, `.tmp-${randomBytes(12).toString('hex')}`)
  const fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o640)
  try {
    await fh.writeFile(data, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  return tmp
}

export async function writeSpoolRequest(inboxDir: string, req: SpoolRequest): Promise<void> {
  const parsed = spoolRequest.parse(req)
  const tmp = await writeExclusiveTmp(inboxDir, JSON.stringify(parsed))
  await rename(tmp, join(inboxDir, `${parsed.id}.json`))
}

// Results never overwrite: link() fails with EEXIST if <id>.json exists.
export async function writeSpoolResultNoClobber(outDir: string, result: SpoolResult): Promise<boolean> {
  const tmp = await writeExclusiveTmp(outDir, JSON.stringify(result))
  try {
    await link(tmp, join(outDir, `${result.id}.json`))
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

// Reads a small regular file without following symlinks.
export async function readSmallFileNoFollow(path: string, max = MAX_SPOOL_DOC_BYTES): Promise<string | null> {
  let fh
  try {
    fh = await open(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw e
  }
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size > max) throw new Error('spool: not a small regular file')
    return await fh.readFile('utf8')
  } finally {
    await fh.close()
  }
}

export async function readSpoolResult(outDir: string, id: string): Promise<SpoolResult | null> {
  if (!UUID_RE.test(id)) throw new Error('spool: bad id')
  const text = await readSmallFileNoFollow(join(outDir, `${id}.json`))
  if (text === null) return null
  const parsed = spoolResult.parse(JSON.parse(text))
  if (parsed.id !== id) throw new Error('spool: result id mismatch')
  return parsed
}

export async function listSpoolIds(dir: string): Promise<string[]> {
  const names = await readdir(dir)
  return names
    .filter((n) => n.endsWith('.json') && UUID_RE.test(n.slice(0, -5)))
    .map((n) => n.slice(0, -5))
    .sort()
}
