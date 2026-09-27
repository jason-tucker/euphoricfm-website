// Spool protocol between web / worker and the network-less music-probe
// (plan §3 "Spool" + the PINNED MOUNTS).
//
//   /spool/probe/in-web/<uuid>.json     written by web      → type 'probe' ONLY
//   /spool/probe/in-worker/<uuid>.json  written by worker   → 'finalize' | 'cover' | 'probe_fetch'
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

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const UPLOAD_ID_RE = /^[0-9a-f]{32}$/
export const COVER_FILE_RE = /^cover-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/
export const SHA256_RE = /^[0-9a-f]{64}$/
export const MAX_UPLOAD_BYTES = 35 * 1024 * 1024
export const MAX_SPOOL_DOC_BYTES = 64 * 1024

export type Inbox = 'in-web' | 'in-worker'

export const INBOX_TYPES: Record<Inbox, readonly string[]> = {
  'in-web': ['probe'],
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
    expectedSize: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  })
  .strict()

export const finalizeRequest = z
  .object({
    v: z.literal(1),
    id: z.string().regex(UUID_RE),
    type: z.literal('finalize'),
    upload: z.string().regex(UPLOAD_ID_RE),
    approvedSha256: z.string().regex(SHA256_RE),
    tags: z.object({ title: tagString, artist: tagString, album: tagString, genre: tagString }).strict(),
    cover: z.object({ file: z.string().regex(COVER_FILE_RE), sha256: z.string().regex(SHA256_RE) }).strict().nullable(),
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

// P3: the worker mounts /staging/final read-only, so it asks the probe to
// remove a finalized file (live or failed + 7 days). Name pattern only.
export const FINAL_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp3$/
export const cleanupFinalRequest = z
  .object({ v: z.literal(1), id: z.string().regex(UUID_RE), type: z.literal('cleanup_final'), file: z.string().regex(FINAL_FILE_RE) })
  .strict()

export const spoolRequest = z.discriminatedUnion('type', [probeRequest, finalizeRequest, coverRequest, probeFetchRequest, cleanupFinalRequest])
export type SpoolRequest = z.infer<typeof spoolRequest>
export type ProbeRequest = z.infer<typeof probeRequest>
export type FinalizeRequest = z.infer<typeof finalizeRequest>

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
})

export const finalizeOk = z.object({
  ...resultBase,
  type: z.literal('finalize'),
  ok: z.literal(true),
  file: z.string().regex(/^[0-9a-f-]{36}\.mp3$/),
  finalSha256: z.string().regex(SHA256_RE),
  size: z.number().int(),
})

export const spoolFailure = z.object({
  ...resultBase,
  type: z.string().max(32),
  ok: z.literal(false),
  error: z.string().max(64),
})

export const cleanupOk = z.object({
  ...resultBase,
  type: z.literal('cleanup_final'),
  ok: z.literal(true),
  removed: z.boolean(),
})

export const spoolResult = z.union([probeOk, finalizeOk, cleanupOk, spoolFailure])
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
