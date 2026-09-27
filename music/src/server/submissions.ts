// Batch / item / comment actions behind the minimal P2 API. Every function
// takes the Viewer from requirePermission() and applies the §3.3 predicates;
// rows the viewer may not see answer 404; transitions are conditional.

import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from './audit'
import { canComment, canSeeComment, canViewOwned, isOwner, isReviewer, isSelfApproval, type Viewer } from './authz/predicates'
import { oneOrConflict } from './authz/transitions'
import type { DB } from './db/client'
import { batches, comments, items, uploads } from './db/schema'
import { badRequest, conflict, forbidden, HttpError, notFound } from './http/errors'
import { enqueue } from './jobs'
import { signMediaUrl } from './media/signing'
import { getIntList, getSetting } from './settings'
import { DEFAULT_CAPS, type Caps } from './settings-defaults'
import { writeSpoolRequest } from './spool/protocol'

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\p{Cc}]/u.test(s.replace(/[\n\t]/g, '')), 'control characters')

export async function createBatch(db: DB, v: Viewer) {
  const [row] = await db.insert(batches).values({ ownerUserId: v.userId, status: 'draft' }).returning()
  await audit(db, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'batch.create', targetType: 'batch', targetId: row!.id })
  return { id: row!.id, status: row!.status }
}

async function loadBatchVisible(db: DB, v: Viewer, id: number) {
  const b = await db.query.batches.findFirst({ where: eq(batches.id, id) })
  if (!b || !canViewOwned(v, b)) throw notFound()
  return b
}

function itemView(v: Viewer, it: typeof items.$inferSelect) {
  return {
    id: it.id,
    batchId: it.batchId,
    kind: it.kind,
    status: it.status,
    title: it.title,
    artist: it.artist,
    album: it.album,
    genre: it.genre,
    durationS: it.durationS,
    bitrate: it.bitrate,
    prefill: it.prefill,
    probeError: it.probeError,
    denyReason: it.denyReason,
    hasCover: Boolean(it.coverFile),
    playlistIds: it.playlistIds,
    ...(isReviewer(v) ? { selfApproved: it.selfApproved, probeSha256: it.probeSha256, decidedBy: it.decidedBy } : {}),
  }
}

export async function getBatch(db: DB, v: Viewer, id: number) {
  const b = await loadBatchVisible(db, v, id)
  const its = await db.query.items.findMany({ where: eq(items.batchId, b.id), orderBy: asc(items.id) })
  return {
    id: b.id,
    status: b.status,
    ticket: b.ticketId ? { number: b.ticketNumber, webUrl: b.ticketWebUrl, discordChannelUrl: b.ticketChannelUrl, status: b.ticketStatus } : null,
    items: its.map((it) => itemView(v, it)),
  }
}

export async function getItem(db: DB, v: Viewer, id: number) {
  const it = await db.query.items.findFirst({ where: eq(items.id, id) })
  if (!it || !canViewOwned(v, it)) throw notFound()
  return itemView(v, it)
}

// Attach a completed tus upload (owned by the viewer) to a draft batch the
// viewer owns, and queue it for the network-less probe.
export async function addUploadToBatch(db: DB, v: Viewer, batchId: number, uploadId: string, spoolInDir: string, caps: Caps = DEFAULT_CAPS) {
  if (!/^[0-9a-f]{32}$/.test(uploadId)) throw badRequest('bad_upload_id')
  const b = await loadBatchVisible(db, v, batchId)
  if (!isOwner(v, b)) throw notFound()
  if (b.status !== 'draft') throw conflict('batch_not_draft')
  const probeRequestId = randomUUID()
  const item = await db.transaction(async (tx) => {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(items)
      .where(and(eq(items.batchId, b.id), inArray(items.status, ['probing', 'pending', 'draft'])))
    if (n >= caps.maxItemsPerBatch) throw new HttpError(409, 'batch_full')
    const up = oneOrConflict(
      await tx
        .update(uploads)
        .set({ status: 'attached' })
        .where(and(eq(uploads.id, uploadId), eq(uploads.ownerUserId, v.userId), eq(uploads.status, 'complete')))
        .returning(),
      'upload_not_available',
    )
    const [row] = await tx
      .insert(items)
      .values({ batchId: b.id, ownerUserId: v.userId, status: 'probing', source: 'upload', uploadId: up.id, probeRequestId })
      .returning()
    await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'item.add', targetType: 'item', targetId: row!.id, detail: { batchId: b.id } })
    return { row: row!, length: up.length }
  })
  try {
    await writeSpoolRequest(spoolInDir, { v: 1, id: probeRequestId, type: 'probe', upload: uploadId, expectedSize: item.length })
  } catch {
    await db.update(items).set({ status: 'rejected', probeError: 'spool_unavailable', updatedAt: new Date() }).where(eq(items.id, item.row.id))
    throw new HttpError(503, 'probe_unavailable')
  }
  return { id: item.row.id, status: item.row.status }
}

export async function submitBatch(db: DB, v: Viewer, batchId: number, attest: unknown) {
  if (attest !== true) throw badRequest('attestation_required')
  const b = await loadBatchVisible(db, v, batchId)
  if (!isOwner(v, b)) throw notFound()
  return db.transaction(async (tx) => {
    const its = await tx.query.items.findMany({ where: eq(items.batchId, b.id) })
    if (its.some((i) => i.status === 'probing')) throw conflict('items_still_probing')
    if (!its.some((i) => i.status === 'pending')) throw conflict('nothing_to_submit')
    const row = oneOrConflict(
      await tx
        .update(batches)
        .set({ status: 'submitted', attestedAt: new Date(), submittedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(batches.id, b.id), eq(batches.status, 'draft')))
        .returning(),
    )
    await enqueue(tx, 'ticket_open', { batchId: b.id }, { dedupeKey: `ticket_open:batch:${b.id}` })
    await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'batch.submit', targetType: 'batch', targetId: b.id })
    return { id: row.id, status: row.status }
  })
}

export async function withdrawItem(db: DB, v: Viewer, itemId: number) {
  const it = await db.query.items.findFirst({ where: eq(items.id, itemId) })
  if (!it || !canViewOwned(v, it)) throw notFound()
  if (!isOwner(v, it)) throw forbidden()
  const row = oneOrConflict(
    await db
      .update(items)
      .set({ status: 'withdrawn', updatedAt: new Date() })
      .where(and(eq(items.id, it.id), eq(items.ownerUserId, v.userId), eq(items.status, 'pending')))
      .returning(),
  )
  await audit(db, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'item.withdraw', targetType: 'item', targetId: it.id })
  return { id: row.id, status: row.status }
}

const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), playlistIds: z.array(z.number().int().positive()).max(16).optional() }).strict(),
  z.object({ decision: z.literal('deny'), reason: text(500).refine((s) => s.trim().length > 0, 'reason required') }).strict(),
])

export async function decideItem(db: DB, v: Viewer, itemId: number, input: unknown) {
  if (!isReviewer(v)) throw forbidden()
  const d = decisionSchema.safeParse(input)
  if (!d.success) throw badRequest('invalid_decision', { issues: d.error.issues.map((i) => i.message) })
  const it = await db.query.items.findFirst({ where: eq(items.id, itemId) })
  if (!it) throw notFound()
  const self = isSelfApproval(v, it)
  return db.transaction(async (tx) => {
    let rows
    if (d.data.decision === 'approve') {
      const assignable = new Set(await getIntList(db, 'assignable_playlist_ids'))
      const chosen = d.data.playlistIds ?? (await getIntList(db, 'default_playlist_ids'))
      if (chosen.some((id) => !assignable.has(id))) throw badRequest('playlist_not_assignable')
      rows = await tx
        .update(items)
        .set({
          status: 'approved',
          // The exact bytes the reviewer previewed: the PROBE-time sha256,
          // copied in SQL, never a re-hash at approval time.
          approvedSha256: sql`${items.probeSha256}`,
          playlistIds: chosen,
          decidedBy: v.discordId,
          decidedAt: new Date(),
          selfApproved: self,
          updatedAt: new Date(),
        })
        .where(and(eq(items.id, it.id), eq(items.status, 'pending'), sql`${items.probeSha256} IS NOT NULL`))
        .returning()
    } else {
      rows = await tx
        .update(items)
        .set({ status: 'denied', denyReason: d.data.reason.trim(), decidedBy: v.discordId, decidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(items.id, it.id), eq(items.status, 'pending')))
        .returning()
    }
    const row = oneOrConflict(rows)
    await audit(tx, {
      actorUserId: v.userId,
      actorDiscordId: v.discordId,
      action: `item.${row.status === 'approved' ? 'approve' : 'deny'}`,
      targetType: 'item',
      targetId: row.id,
      detail: { selfApproved: self, playlistIds: row.playlistIds },
    })
    await enqueue(tx, 'ticket_decision', { itemId: row.id }, { dedupeKey: `ticket_decision:item:${row.id}:${row.status}` })
    return { id: row.id, status: row.status, selfApproved: self }
  })
}

const commentSchema = z
  .object({
    body: text(2000).refine((s) => s.trim().length > 0, 'empty'),
    visibility: z.enum(['all', 'staff']).default('all'),
    itemId: z.number().int().positive().optional(),
  })
  .strict()

export async function addComment(db: DB, v: Viewer, batchId: number, input: unknown) {
  const c = commentSchema.safeParse(input)
  if (!c.success) throw badRequest('invalid_comment')
  const b = await loadBatchVisible(db, v, batchId)
  if (!canComment(v, b, c.data.visibility)) throw forbidden()
  if (c.data.itemId !== undefined) {
    const it = await db.query.items.findFirst({ where: and(eq(items.id, c.data.itemId), eq(items.batchId, b.id)) })
    if (!it) throw badRequest('item_not_in_batch')
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(comments)
      .values({
        batchId: b.id,
        itemId: c.data.itemId ?? null,
        authorUserId: v.userId,
        authorDiscordId: v.discordId,
        authorName: v.name,
        source: 'portal',
        visibility: c.data.visibility,
        body: c.data.body.trim(),
      })
      .returning()
    // Only public comments are ever queued for the ticket. The worker and the
    // tickets client each refuse staff comments again.
    if (row!.visibility === 'all') await enqueue(tx, 'ticket_comment', { commentId: row!.id }, { dedupeKey: `ticket_comment:${row!.id}` })
    await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'comment.add', targetType: 'comment', targetId: row!.id, detail: { visibility: row!.visibility, batchId: b.id } })
    return { id: row!.id, visibility: row!.visibility }
  })
}

export async function listComments(db: DB, v: Viewer, batchId: number) {
  const b = await loadBatchVisible(db, v, batchId)
  const rows = await db.query.comments.findMany({ where: eq(comments.batchId, b.id), orderBy: asc(comments.id) })
  return rows
    .filter((c) => canSeeComment(v, b, c))
    .map((c) => ({ id: c.id, itemId: c.itemId, body: c.body, visibility: c.visibility, source: c.source, authorName: c.authorName, createdAt: c.createdAt }))
}

export async function previewUrls(db: DB, v: Viewer, itemId: number) {
  const it = await db.query.items.findFirst({ where: eq(items.id, itemId) })
  if (!it || !canViewOwned(v, it)) throw notFound()
  if (!it.probeSha256 || !it.uploadId) throw conflict('not_probed')
  return {
    audioUrl: signMediaUrl('audio', it.id, v.userId),
    coverUrl: it.coverFile ? signMediaUrl('cover', it.id, v.userId) : null,
  }
}

export async function listOwnItems(db: DB, v: Viewer) {
  const rows = await db.query.items.findMany({ where: eq(items.ownerUserId, v.userId), orderBy: asc(items.id), limit: 200 })
  return rows.map((it) => itemView(v, it))
}

export { getSetting }
