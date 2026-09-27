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
//
// Memory and quotas (v0.2.1, review SEC-1 / SEC-2). music-web runs with
// mem_limit 256m, so a POST reads its body only after it has
//   1. taken an in-flight slot: at most ART_INFLIGHT_PER_USER (1) per user
//      and ART_INFLIGHT_GLOBAL (3) in this process (429 / 503 otherwise);
//   2. passed the quota pre-check (processing count, daily count and bytes,
//      global art bytes, staging bytes) with nothing read yet.
// The body is then read into ONE buffer of its Content-Length (≤5 MB + 64
// KB, 411 without one), the multipart part is a view into that buffer and
// is validated and written to disk from it: no further copies. Worst case
// ≈ ART_INFLIGHT_GLOBAL x ART_BODY_LIMIT ≈ 15.2 MB of bodies, plus one
// stream chunk per request; a request waiting on a refusal holds only its
// headers (and whatever the socket had buffered). The slot is released in
// a finally, and a sender slower than ART_BODY_DEADLINE_MS gets 408 so it
// cannot hold a slot indefinitely.
// Before the row exists, the byte caps are checked again with the real size
// under the staging advisory lock (admitArtUpload), which also inserts the
// row, so concurrent uploads cannot overshoot any cap.

import { randomUUID } from 'node:crypto'
import { constants as FS } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { audit } from '../audit'
import { isReviewer, type Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { artUploads } from '../db/schema'
import { readBodyExact } from '../http/body'
import { HttpError, notFound } from '../http/errors'
import { signMediaUrl } from '../media/signing'
import { DEFAULT_CAPS, type Caps } from '../settings-defaults'
import { lockStaging, stagedBytes, type Refusal } from '../uploads/caps'
import { sha256File } from '../../probe/files'
import { dimsAcceptable, imageComplete, imageDims, sniffImage } from '../../probe/cover'
import { ART_JPEG_FILE, MAX_ART_BYTES, readSpoolResult, UUID_RE, writeSpoolRequest } from '../spool/protocol'
import { multipartBoundary, singlePart } from './multipart'

export type ArtDirs = { artIn: string; art: string; spoolIn: string; spoolOut: string }

export const ART_UPLOAD_KINDS = new Set(['jpeg', 'png', 'webp'])
// Multipart framing around a 5 MB file stays far below 64 KB.
export const ART_BODY_LIMIT = MAX_ART_BYTES + 64 * 1024
export const MAX_PROCESSING_ART_PER_USER = 5
// In-flight POST bodies in this process (memory bound above). Not settings:
// they size music-web's memory, not a member's quota.
export const ART_INFLIGHT_PER_USER = 1
export const ART_INFLIGHT_GLOBAL = 3
// 5 MB in 120 s is ~350 kbit/s; slower senders retry.
export const ART_BODY_DEADLINE_MS = 120_000

export function artJpegPath(artDir: string, artId: string): string {
  return join(artDir, artId, ART_JPEG_FILE)
}

// Refusals sent before the body is read carry Connection: close, so the
// unread rest cannot be taken for the next request on a keep-alive socket.
function refusalError(r: Refusal, beforeBody = false): HttpError {
  return new HttpError(r.status, r.code, undefined, {
    ...(r.retryAfterS ? { 'Retry-After': String(r.retryAfterS) } : {}),
    ...(beforeBody ? { Connection: 'close' } : {}),
  })
}

// Counting semaphore per user and for the process. acquire() never waits:
// a full gate refuses at once (the client retries after Retry-After).
export class ArtGate {
  private readonly byUser = new Map<string, number>()
  private total = 0
  constructor(
    readonly perUser = ART_INFLIGHT_PER_USER,
    readonly global = ART_INFLIGHT_GLOBAL,
  ) {}

  acquire(userId: string): () => void {
    const mine = this.byUser.get(userId) ?? 0
    if (mine >= this.perUser) throw refusalError({ status: 429, code: 'art_upload_in_progress', retryAfterS: 10 }, true)
    if (this.total >= this.global) throw refusalError({ status: 503, code: 'art_uploads_busy', retryAfterS: 10 }, true)
    this.byUser.set(userId, mine + 1)
    this.total++
    let released = false
    return () => {
      if (released) return
      released = true
      this.total--
      const n = (this.byUser.get(userId) ?? 1) - 1
      if (n > 0) this.byUser.set(userId, n)
      else this.byUser.delete(userId)
    }
  }

  get inFlight(): number {
    return this.total
  }
}

// One gate per process (survives module re-evaluation, like the tus server).
const g = globalThis as unknown as { __efmArtGate?: ArtGate }
export function artGate(): ArtGate {
  return (g.__efmArtGate ??= new ArtGate())
}

type Q = Pick<DB, 'execute'>

// Every art cap for one more upload of `length` bytes by `userId`.
// Pre-check (before the body): length 1, no lock. Admission: the real size,
// under lockStaging, in the transaction that inserts the row.
export async function artQuotaRefusal(q: Q, userId: string, length: number, caps: Caps = DEFAULT_CAPS): Promise<Refusal | null> {
  const [u] = await q.execute<{ processing: number; day_n: number; day_bytes: string }>(
    sql`SELECT
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS day_n,
          COALESCE(SUM(raw_size) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::bigint AS day_bytes
        FROM ${artUploads}
        WHERE owner = ${userId} AND (status = 'processing' OR created_at > now() - interval '24 hours')`,
  )
  if (Number(u?.processing ?? 0) >= MAX_PROCESSING_ART_PER_USER) return { status: 429, code: 'too_many_art_uploads_processing', retryAfterS: 30 }
  if (Number(u?.day_n ?? 0) >= caps.artUploadsPerUserPerDay) return { status: 429, code: 'art_daily_quota', retryAfterS: 3600 }
  if (Number(u?.day_bytes ?? 0) + length > caps.artBytesPerUserPerDay) return { status: 429, code: 'art_daily_quota', retryAfterS: 3600 }
  const staged = await stagedBytes(q)
  if (staged.art + length > caps.maxArtBytes) return { status: 503, code: 'art_storage_full', retryAfterS: 600 }
  if (staged.uploads + staged.art + length > caps.maxStagingBytes) return { status: 503, code: 'staging_full', retryAfterS: 600 }
  return null
}

// Checks every cap with the real size and inserts the 'processing' row, in
// one transaction under the staging lock.
export async function admitArtUpload(db: DB, userId: string, artId: string, rawPath: string, length: number, caps: Caps = DEFAULT_CAPS): Promise<Refusal | null> {
  return db.transaction(async (tx) => {
    await lockStaging(tx)
    const refusal = await artQuotaRefusal(tx, userId, length, caps)
    if (refusal) return refusal
    await tx.insert(artUploads).values({ id: artId, owner: userId, status: 'processing', rawPath, rawSize: length })
    return null
  })
}

// Reads and checks the multipart body; returns the image bytes as a view
// into the single body buffer (see the memory note above).
export async function readArtUpload(req: Request): Promise<Buffer> {
  const ct = req.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data;\s*boundary=/i.test(ct)) throw new HttpError(415, 'multipart_required')
  const boundary = multipartBoundary(ct)
  if (!boundary) throw new HttpError(400, 'bad_multipart')
  const raw = await readBodyExact(req, ART_BODY_LIMIT, ART_BODY_DEADLINE_MS)
  const part = singlePart(raw, boundary)
  if (part.name !== 'art') throw new HttpError(400, 'exactly_one_art_field')
  if (!part.isFile) throw new HttpError(400, 'art_must_be_a_file')
  const bytes = part.data
  if (bytes.length < 1) throw new HttpError(400, 'empty_file')
  if (bytes.length > MAX_ART_BYTES) throw new HttpError(413, 'art_too_large')
  const kind = sniffImage(bytes)
  if (!kind || !ART_UPLOAD_KINDS.has(kind)) throw new HttpError(415, 'unsupported_image_type')
  const dims = imageDims(bytes, kind)
  if (!dims) throw new HttpError(422, 'unreadable_image_header')
  if (!dimsAcceptable(dims)) throw new HttpError(422, 'image_too_large')
  if (!imageComplete(bytes, kind)) throw new HttpError(422, 'image_truncated')
  return bytes
}

// The whole POST after authentication: slot, pre-check, body, admission.
export async function acceptArtUpload(db: DB, v: Viewer, req: Request, dirs: ArtDirs, caps: Caps = DEFAULT_CAPS, gate: ArtGate = artGate()) {
  const release = gate.acquire(v.userId)
  try {
    const pre = await artQuotaRefusal(db, v.userId, 1, caps)
    if (pre) throw refusalError(pre, true)
    const bytes = await readArtUpload(req)
    return await createArtUpload(db, v, bytes, dirs, caps)
  } finally {
    release()
  }
}

export async function createArtUpload(db: DB, v: Viewer, bytes: Buffer, dirs: ArtDirs, caps: Caps = DEFAULT_CAPS): Promise<{ artId: string; status: 'processing' }> {
  const artId = randomUUID()
  const rawPath = join(dirs.artIn, artId)
  const refusal = await admitArtUpload(db, v.userId, artId, rawPath, bytes.length, caps)
  if (refusal) throw refusalError(refusal)
  const fail = async (reason: string) => {
    await db.update(artUploads).set({ status: 'rejected', reason, updatedAt: new Date() }).where(eq(artUploads.id, artId))
    await unlink(rawPath).catch(() => {})
  }
  try {
    const fh = await open(rawPath, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o640)
    try {
      await fh.writeFile(bytes)
      await fh.sync()
    } finally {
      await fh.close()
    }
  } catch {
    await fail('write_failed')
    throw new HttpError(503, 'art_write_failed', undefined, { 'Retry-After': '60' })
  }
  await audit(db, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'art.upload', targetType: 'art', targetId: artId, detail: { size: bytes.length } })
  try {
    await writeSpoolRequest(dirs.spoolIn, { v: 1, id: artId, type: 'art', expectedSize: bytes.length })
  } catch {
    await fail('probe_unavailable')
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
