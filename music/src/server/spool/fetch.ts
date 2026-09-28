// The music-fetch spool, worker side (v0.4.0; fetch/README.md "Spool protocol").
//
//   /spool/fetch/in/<uuid>.json       written by the worker (rw mount)
//   /spool/fetch/in/<uuid>.release    written by the worker once the probe has
//                                     converted or refused the job's audio:
//                                     music-fetch then deletes the job's
//                                     staging dir (the raw media)
//   /spool/fetch/out/<uuid>.json      written by music-fetch, read-only here
//
// The web never talks to music-fetch: it only records the link and queues a
// worker job. music-fetch's result is untrusted input (it is the only
// container with internet egress and runs yt-dlp on remote data): it is read
// without following links, size-capped and parsed with a strict schema, and
// every path in it is re-derived from the job's own uuid before use.

import { constants as FS } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { CANONICAL_URL_RE, FETCH_ERROR_CODES, LICENSE_RE } from '../../lib/soundcloud'
import { MAX_SPOOL_DOC_BYTES, readSmallFileNoFollow, SHA256_RE, UUID_RE } from './protocol'

export const MAX_FETCH_REQUEST_BYTES = 4 * 1024
// music-fetch's media cap (fetch/fetchsvc/runner.py MAX_AUDIO_BYTES, 60 MiB).
export const MAX_FETCH_AUDIO_BYTES = 60 * 1024 * 1024
export const REQUESTED_BY_RE = /^[A-Za-z0-9_.:-]{1,64}$/

export type FetchRequest = { uuid: string; url: string; requestedBy: string }

async function writeTmp(dir: string, data: string): Promise<string> {
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

// Atomic (exclusive tmp file + rename), exactly the keys music-fetch accepts.
export async function writeFetchRequest(inDir: string, r: FetchRequest): Promise<void> {
  if (!UUID_RE.test(r.uuid)) throw new Error('fetch spool: bad uuid')
  if (!REQUESTED_BY_RE.test(r.requestedBy)) throw new Error('fetch spool: bad requestedBy')
  const doc = JSON.stringify({ v: 1, uuid: r.uuid, url: r.url, requestedBy: r.requestedBy })
  if (Buffer.byteLength(doc) > MAX_FETCH_REQUEST_BYTES) throw new Error('fetch spool: request too large')
  const tmp = await writeTmp(inDir, doc)
  try {
    await rename(tmp, join(inDir, `${r.uuid}.json`))
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

// Best effort: a lost marker only leaves the raw media to music-fetch's
// 24 h staging sweep.
export async function writeFetchRelease(inDir: string, uuid: string): Promise<boolean> {
  if (!UUID_RE.test(uuid)) return false
  try {
    const tmp = await writeTmp(inDir, '')
    try {
      await rename(tmp, join(inDir, `${uuid}.release`))
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
    return true
  } catch {
    return false
  }
}

// Lengths: music-fetch caps title / uploader at 200, genre at 100 and the
// description at 4000 CODE POINTS; zod counts UTF-16 units, so the bounds
// here are doubled. The portal clips again (clipTag) before using them.
const text = (max: number) => z.string().max(max)
const fetchMeta = z
  .object({
    title: text(400).nullable(),
    uploader: text(400).nullable(),
    duration: z.number().finite().nonnegative().max(86_400),
    genre: text(200).optional(),
    description: text(8000).optional(),
    artworkSourceHost: z.string().max(253).regex(/^[a-z0-9.-]+$/).nullable(),
    license: z.string().regex(LICENSE_RE).optional(),
    trackId: z.string().regex(/^\d{1,20}$/).optional(),
  })
  .strict()

export const fetchOk = z
  .object({
    v: z.literal(1),
    uuid: z.string().regex(UUID_RE),
    status: z.literal('ok'),
    errorCode: z.null(),
    files: z.object({ audio: z.string().max(200), artwork: z.string().max(200).optional() }).strict(),
    meta: fetchMeta,
    rawSha256: z.string().regex(SHA256_RE),
    audioBytes: z.number().int().min(1).max(MAX_FETCH_AUDIO_BYTES),
    container: z.enum(['mp3', 'mp4', 'ogg', 'opus', 'wav', 'flac']),
    ffmpegFormat: z.enum(['mp3', 'mp4', 'ogg', 'wav', 'flac']),
    artworkSha256: z.string().regex(SHA256_RE).optional(),
    canonicalUrl: z.string().max(300),
    warnings: z.array(z.string().max(64)).max(16),
  })
  .strict()

export const fetchError = z
  .object({
    v: z.literal(1),
    uuid: z.string().regex(UUID_RE),
    status: z.literal('error'),
    errorCode: z.enum(FETCH_ERROR_CODES),
    files: z.null(),
    meta: z.null(),
    rawSha256: z.null(),
  })
  .strict()

export const fetchResult = z.discriminatedUnion('status', [fetchOk, fetchError])
export type FetchOk = z.infer<typeof fetchOk>
export type FetchResult = z.infer<typeof fetchResult>

// null = no result yet. Throws on anything that is not a well-formed result
// for this uuid (the caller rejects the item: a result is written once and
// never replaced, so waiting would not help).
export async function readFetchResult(outDir: string, uuid: string): Promise<FetchResult | null> {
  if (!UUID_RE.test(uuid)) throw new Error('fetch spool: bad uuid')
  const raw = await readSmallFileNoFollow(join(outDir, `${uuid}.json`), MAX_SPOOL_DOC_BYTES)
  if (raw === null) return null
  const parsed = fetchResult.parse(JSON.parse(raw))
  if (parsed.uuid !== uuid) throw new Error('fetch spool: result uuid mismatch')
  return parsed
}

export async function fetchResultExists(outDir: string, uuid: string): Promise<boolean> {
  if (!UUID_RE.test(uuid)) return false
  try {
    const fh = await open(join(outDir, `${uuid}.json`), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
    await fh.close()
    return true
  } catch {
    return false
  }
}

// The audio / artwork paths music-fetch reported, checked against the ONLY
// shape they may have for this job; the probe builds them again itself.
export const FETCH_AUDIO_EXTS = ['m4a', 'mp4', 'opus', 'ogg', 'oga', 'mp3'] as const
export type FetchAudioExt = (typeof FETCH_AUDIO_EXTS)[number]

export function audioExtOf(uuid: string, path: string): FetchAudioExt | null {
  const m = /^\/staging\/fetch\/([0-9a-f-]{36})\/audio\.([a-z0-9]{2,4})$/.exec(path)
  if (!m || m[1] !== uuid) return null
  return (FETCH_AUDIO_EXTS as readonly string[]).includes(m[2]!) ? (m[2] as FetchAudioExt) : null
}

export function artworkPathOk(uuid: string, path: string): boolean {
  return path === `/staging/fetch/${uuid}/artwork.raw`
}

export function canonicalUrlOk(url: string): boolean {
  return CANONICAL_URL_RE.test(url)
}
