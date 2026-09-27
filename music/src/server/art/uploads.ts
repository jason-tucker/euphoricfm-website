// Standalone album-art uploads (art contract 2026-09-27), web side.
//
//   POST /api/uploads/art        multipart/form-data, exactly one field `art`
//                                (a file), ≤5 MB, JPEG/PNG/WebP by magic bytes
//                                (never the client MIME type; no SVG, no GIF);
//                                202 {artId, status:'processing'}
//   GET  /api/uploads/art/:id    {artId, status, reason?, previewUrl?}; only
//                                the uploader or `review` (others: 404)
//
// The raw bytes go to <art-in>/<artId> (web-writable), a row goes into
// art_uploads, and an 'art' request is spooled to the network-less probe,
// which alone writes <art>/<artId>/cover.jpg (read-only for web + worker).
// The status call collects the probe's result, re-hashes the published JPEG
// and records its sha256; the preview is a signed, short-lived URL served as
// image/jpeg with nosniff + CSP sandbox.

import { randomUUID } from 'node:crypto'
import { constants as FS } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { audit } from '../audit'
import { isReviewer, type Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { artUploads } from '../db/schema'
import { readBodyLimited } from '../http/body'
import { HttpError, notFound } from '../http/errors'
import { signMediaUrl } from '../media/signing'
import { sha256File } from '../../probe/files'
import { dimsAcceptable, imageComplete, imageDims, sniffImage } from '../../probe/cover'
import { ART_JPEG_FILE, MAX_ART_BYTES, readSpoolResult, UUID_RE, writeSpoolRequest } from '../spool/protocol'

export type ArtDirs = { artIn: string; art: string; spoolIn: string; spoolOut: string }

export const ART_UPLOAD_KINDS = new Set(['jpeg', 'png', 'webp'])
// Multipart framing around a 5 MB file stays far below 64 KB.
export const ART_BODY_LIMIT = MAX_ART_BYTES + 64 * 1024
export const MAX_PROCESSING_ART_PER_USER = 5

export function artJpegPath(artDir: string, artId: string): string {
  return join(artDir, artId, ART_JPEG_FILE)
}

// Parses and checks the multipart body; returns the raw image bytes.
export async function readArtUpload(req: Request): Promise<Buffer> {
  const ct = req.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data;\s*boundary=/i.test(ct)) throw new HttpError(415, 'multipart_required')
  const raw = await readBodyLimited(req, ART_BODY_LIMIT)
  let form: FormData
  try {
    form = await new Response(new Uint8Array(raw), { headers: { 'content-type': ct } }).formData()
  } catch {
    throw new HttpError(400, 'bad_multipart')
  }
  const entries = [...form.entries()]
  if (entries.length !== 1 || entries[0]![0] !== 'art') throw new HttpError(400, 'exactly_one_art_field')
  const file = entries[0]![1]
  if (typeof file === 'string') throw new HttpError(400, 'art_must_be_a_file')
  if (file.size < 1) throw new HttpError(400, 'empty_file')
  if (file.size > MAX_ART_BYTES) throw new HttpError(413, 'art_too_large')
  const bytes = Buffer.from(await file.arrayBuffer())
  const kind = sniffImage(bytes)
  if (!kind || !ART_UPLOAD_KINDS.has(kind)) throw new HttpError(415, 'unsupported_image_type')
  const dims = imageDims(bytes, kind)
  if (!dims) throw new HttpError(422, 'unreadable_image_header')
  if (!dimsAcceptable(dims)) throw new HttpError(422, 'image_too_large')
  if (!imageComplete(bytes, kind)) throw new HttpError(422, 'image_truncated')
  return bytes
}

export async function createArtUpload(db: DB, v: Viewer, bytes: Buffer, dirs: ArtDirs): Promise<{ artId: string; status: 'processing' }> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(artUploads)
    .where(and(eq(artUploads.owner, v.userId), eq(artUploads.status, 'processing')))
  if (n >= MAX_PROCESSING_ART_PER_USER) throw new HttpError(429, 'too_many_art_uploads_processing', undefined, { 'Retry-After': '30' })
  const artId = randomUUID()
  const rawPath = join(dirs.artIn, artId)
  const fh = await open(rawPath, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o640)
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await db.insert(artUploads).values({ id: artId, owner: v.userId, status: 'processing', rawPath, rawSize: bytes.length })
  await audit(db, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'art.upload', targetType: 'art', targetId: artId, detail: { size: bytes.length } })
  try {
    await writeSpoolRequest(dirs.spoolIn, { v: 1, id: artId, type: 'art', expectedSize: bytes.length })
  } catch {
    await db.update(artUploads).set({ status: 'rejected', reason: 'probe_unavailable', updatedAt: new Date() }).where(eq(artUploads.id, artId))
    await unlink(rawPath).catch(() => {})
    throw new HttpError(503, 'probe_unavailable')
  }
  return { artId, status: 'processing' }
}

type ArtRow = typeof artUploads.$inferSelect

// Collects the probe's result for a 'processing' row (idempotent; the
// UPDATE is conditional on the row still processing).
export async function collectArtResult(db: DB, row: ArtRow, dirs: Pick<ArtDirs, 'art' | 'spoolOut'>): Promise<ArtRow> {
  if (row.status !== 'processing') return row
  let r
  try {
    r = await readSpoolResult(dirs.spoolOut, row.id)
  } catch {
    r = { ok: false as const, error: 'bad_probe_result', type: 'art', source: 'in-web' as const }
  }
  if (!r) return row
  let set: Partial<ArtRow>
  if (r.source !== 'in-web' || r.type !== 'art') set = { status: 'rejected', reason: 'wrong_result_source' }
  else if (!r.ok) set = { status: 'rejected', reason: r.error.slice(0, 64) }
  else if (!('sha256' in r) || !('width' in r)) set = { status: 'rejected', reason: 'bad_probe_result' }
  else {
    // Re-hash what the probe published: the recorded sha is of the bytes on disk.
    const path = artJpegPath(dirs.art, row.id)
    const sha = await sha256File(path).catch(() => null)
    set = sha === r.sha256 ? { status: 'ready', jpegPath: path, jpegSha256: sha, width: r.width, height: r.height } : { status: 'rejected', reason: 'publish_mismatch' }
  }
  const [updated] = await db
    .update(artUploads)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(artUploads.id, row.id), eq(artUploads.status, 'processing')))
    .returning()
  if (updated && row.rawPath) await unlink(row.rawPath).catch(() => {})
  return updated ?? (await db.query.artUploads.findFirst({ where: eq(artUploads.id, row.id) })) ?? row
}

// Owner or `review` only; anything else (or a malformed id) is 404.
export async function loadArtVisible(db: DB, v: Viewer, artId: string): Promise<ArtRow> {
  if (!UUID_RE.test(artId)) throw notFound()
  const row = await db.query.artUploads.findFirst({ where: eq(artUploads.id, artId) })
  if (!row || (row.owner !== v.userId && !isReviewer(v))) throw notFound()
  return row
}

export async function getArtStatus(db: DB, v: Viewer, artId: string, dirs: Pick<ArtDirs, 'art' | 'spoolOut'>) {
  const row = await collectArtResult(db, await loadArtVisible(db, v, artId), dirs)
  return {
    artId: row.id,
    status: row.status,
    ...(row.status === 'rejected' || row.status === 'expired' ? { reason: row.reason ?? row.status } : {}),
    ...(row.status === 'ready' ? { previewUrl: signMediaUrl('art', row.id, v.userId), width: row.width, height: row.height } : {}),
  }
}
