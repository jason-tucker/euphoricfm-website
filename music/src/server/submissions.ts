// Batch / item / comment actions behind the minimal P2 API. Every function
// takes the Viewer from requirePermission() and applies the §3.3 predicates;
// rows the viewer may not see answer 404; transitions are conditional.

import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from './audit'
import { canComment, canSeeComment, canViewOwned, isOwner, isReviewer, isSelfApproval, type Viewer } from './authz/predicates'
import { oneOrConflict } from './authz/transitions'
import type { DB } from './db/client'
import { batches, comments, items, uploads } from './db/schema'
import { badRequest, conflict, forbidden, HttpError, notFound } from './http/errors'
import { enqueue } from './jobs'
import { isUsableArt, loadArt } from './library/art'
import { afterApprove, ensureNewArtistItems } from './library/artists'
import { mayHaveCover } from './media/cover'
import { signMediaUrl } from './media/signing'
import { metaText } from './requests/common'
import { getIntList, getSetting, loadCaps } from './settings'
import { DEFAULT_CAPS, type Caps } from './settings-defaults'
import { MAX_WAV_UPLOAD_BYTES, writeSpoolRequest } from './spool/protocol'

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
    artistId: it.artistId,
    newArtistName: it.newArtistName,
    title: it.title,
    artist: it.artist,
    album: it.album,
    genre: it.genre,
    durationS: it.durationS,
    bitrate: it.bitrate,
    prefill: it.prefill,
    probeError: it.probeError,
    denyReason: it.denyReason,
    inputFormat: it.inputFormat,
    hasCover: Boolean(it.coverFile),
    customArtId: it.customArtId,
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
    // Lock the batch row: a concurrent submit (which takes the same lock)
    // either sees this item or this add sees the submitted batch.
    const [locked] = await tx.select({ status: batches.status }).from(batches).where(eq(batches.id, b.id)).for('update')
    if (locked?.status !== 'draft') throw conflict('batch_not_draft')
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
    // maxWavBytes: the loaded (possibly admin-lowered) WAV cap, which the
    // probe applies to an upload that turns out to be a WAV (v0.3.0).
    const maxWavBytes = Math.min((await loadCaps(db)).maxWavUploadBytes, MAX_WAV_UPLOAD_BYTES)
    await writeSpoolRequest(spoolInDir, { v: 1, id: probeRequestId, type: 'probe', upload: uploadId, expectedSize: item.length, maxWavBytes })
  } catch {
    await db.update(items).set({ status: 'rejected', probeError: 'spool_unavailable', updatedAt: new Date() }).where(eq(items.id, item.row.id))
    throw new HttpError(503, 'probe_unavailable')
  }
  return { id: item.row.id, status: item.row.status }
}

export const ATTEST_VERSION_RE = /^[A-Za-z0-9._:-]{1,40}$/

export async function submitBatch(db: DB, v: Viewer, batchId: number, attest: unknown, attestVersion?: unknown) {
  if (attest !== true) throw badRequest('attestation_required')
  if (attestVersion !== undefined && (typeof attestVersion !== 'string' || !ATTEST_VERSION_RE.test(attestVersion))) throw badRequest('bad_attest_version')
  const b = await loadBatchVisible(db, v, batchId)
  if (!isOwner(v, b)) throw notFound()
  return db.transaction(async (tx) => {
    await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, b.id)).for('update')
    const its = await tx.query.items.findMany({ where: eq(items.batchId, b.id) })
    if (its.some((i) => i.status === 'probing')) throw conflict('items_still_probing')
    if (!its.some((i) => i.status === 'pending')) throw conflict('nothing_to_submit')
    const row = oneOrConflict(
      await tx
        .update(batches)
        .set({ status: 'submitted', attestedAt: new Date(), attestVersion: (attestVersion as string | undefined) ?? null, submittedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(batches.id, b.id), eq(batches.status, 'draft')))
        .returning(),
    )
    // P3: songs by artists not in `artists` get a linked new_artist item.
    await ensureNewArtistItems(tx, b.id, b.ownerUserId)
    await enqueue(tx, 'ticket_open', { batchId: b.id }, { dedupeKey: `ticket_open:batch:${b.id}` })
    // Public comments written while the batch was a draft go to the ticket now.
    const waiting = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.batchId, b.id), eq(comments.visibility, 'all'), eq(comments.source, 'portal'), sql`${comments.ticketMessageId} IS NULL`))
    for (const c of waiting) await enqueue(tx, 'ticket_comment', { commentId: c.id }, { dedupeKey: `ticket_comment:${c.id}` })
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

// PATCH /api/items/:id — per-field overrides that become the metadata the
// ingest writes (finalize tags + file name). The owner may edit a pending
// item while its batch is still a draft; a reviewer may edit a pending item
// of a submitted batch before the decision. Conditional UPDATE: 409 once it is decided.
// The edit-request rule (requests/common.ts metaText): a newline or tab here
// used to pass and then fail finalize after approval, and \p{Cf} reached the
// on-air tags. 200 = the finalize tag limit (spool/protocol.ts tagString).
const metaField = metaText(200)
const editSchema = z
  .object({
    title: metaField.refine((s) => s.length > 0, 'title required').optional(),
    artist: metaField.refine((s) => s.length > 0, 'artist required').optional(),
    album: metaField.nullable().optional(),
    genre: metaField.nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'no fields')

// Shared by the metadata PATCH and the art PUT/DELETE: who may edit a
// pending song item, and the conditional WHERE that enforces it at write
// time (409 once the item is decided or the batch submitted).
async function loadEditableItem(db: DB, v: Viewer, itemId: number) {
  const it = await db.query.items.findFirst({ where: eq(items.id, itemId) })
  if (!it || !canViewOwned(v, it)) throw notFound()
  if (it.kind !== 'song') throw conflict('not_editable')
  const reviewer = isReviewer(v)
  if (!reviewer && !isOwner(v, it)) throw notFound()
  // The owner edits while the batch is a draft. A reviewer edits only items
  // of a SUBMITTED (attested) batch, like a decision (BATCH_DECIDABLE_SQL):
  // an unsubmitted draft is still the member's to change or withdraw.
  const ownerDraft = and(
    eq(items.ownerUserId, v.userId),
    sql`EXISTS (SELECT 1 FROM ${batches} WHERE ${batches.id} = ${items.batchId} AND ${batches.status} = 'draft')`,
  )
  const where = reviewer
    ? and(eq(items.id, it.id), eq(items.status, 'pending'), or(ownerDraft, BATCH_DECIDABLE_SQL))
    : and(eq(items.id, it.id), eq(items.status, 'pending'), ownerDraft)
  return { it, reviewer, where }
}

export async function editItemMetadata(db: DB, v: Viewer, itemId: number, input: unknown) {
  const e = editSchema.safeParse(input)
  if (!e.success) throw badRequest('invalid_edit', { issues: e.error.issues.map((i) => i.message) })
  const { it, reviewer, where } = await loadEditableItem(db, v, itemId)
  const patch: Partial<typeof items.$inferInsert> = { updatedAt: new Date() }
  const changes: Record<string, { from: string | null; to: string | null }> = {}
  for (const k of ['title', 'artist', 'album', 'genre'] as const) {
    const val = e.data[k]
    if (val === undefined) continue
    const to = val === null || val === '' ? null : val
    if ((it[k] ?? null) === to) continue
    patch[k] = to
    changes[k] = { from: it[k] ?? null, to }
  }
  // A different artist must be resolved again (known artist or new-artist item).
  if ('artist' in changes) Object.assign(patch, { artistId: null, newArtistName: null })
  return db.transaction(async (tx) => {
    const row = oneOrConflict(await tx.update(items).set(patch).where(where).returning(), 'not_editable')
    if (Object.keys(changes).length > 0) {
      await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'item.edit', targetType: 'item', targetId: row.id, detail: { changes, asReviewer: reviewer && !isOwner(v, it) } })
      if ('artist' in changes) {
        const b = await tx.query.batches.findFirst({ where: eq(batches.id, row.batchId) })
        if (b && b.status !== 'draft') await ensureNewArtistItems(tx, b.id, b.ownerUserId)
      }
    }
    const fresh = await tx.query.items.findFirst({ where: eq(items.id, row.id) })
    return itemView(v, fresh!)
  })
}

// PUT /api/items/:id/art {artId} and DELETE: custom album art (art
// contract). Same editors and 409 rule as the metadata PATCH. The upload must
// be the viewer's own and `ready` (probe-verified JPEG).
const artSchema = z.object({ artId: z.string().uuid() }).strict()

export async function setItemArt(db: DB, v: Viewer, itemId: number, input: unknown) {
  const a = artSchema.safeParse(input)
  if (!a.success) throw badRequest('invalid_art')
  const { it, reviewer, where } = await loadEditableItem(db, v, itemId)
  const art = await loadArt(db, a.data.artId)
  if (!art || art.owner !== v.userId) throw notFound()
  if (!isUsableArt(art)) throw conflict('art_not_ready')
  const row = oneOrConflict(await db.update(items).set({ customArtId: art.id, updatedAt: new Date() }).where(where).returning(), 'not_editable')
  await audit(db, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'item.art.set', targetType: 'item', targetId: row.id, detail: { artId: art.id, from: it.customArtId, asReviewer: reviewer && !isOwner(v, it) } })
  return itemView(v, row)
}

export async function clearItemArt(db: DB, v: Viewer, itemId: number) {
  const { it, reviewer, where } = await loadEditableItem(db, v, itemId)
  const row = oneOrConflict(await db.update(items).set({ customArtId: null, updatedAt: new Date() }).where(where).returning(), 'not_editable')
  if (it.customArtId) await audit(db, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'item.art.clear', targetType: 'item', targetId: row.id, detail: { from: it.customArtId, asReviewer: reviewer && !isOwner(v, it) } })
  return itemView(v, row)
}

const decisionSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('approve'),
      playlistIds: z.array(z.number().int().positive()).max(16).optional(),
      // new_artist items only: the reviewer-confirmed folder (strict sanitizer output)
      folder: z.string().max(300).optional(),
    })
    .strict(),
  z.object({ decision: z.literal('deny'), reason: text(500).refine((s) => s.trim().length > 0, 'reason required') }).strict(),
])

// Items become 'pending' as soon as their probe succeeds, which can be while
// their batch is still a DRAFT (no attestation, no ticket, the member may
// still withdraw). Reviewers may decide an item only once its batch has been
// submitted with the rights attestation. Use both helpers on every reviewer
// path: assertBatchDecidable() for the early, readable 409, and
// BATCH_DECIDABLE_SQL inside the conditional UPDATE (race-safe) and in any
// review-queue query (so drafts never show up to reviewers as decidable).
export const DECIDABLE_BATCH_STATUSES = ['submitted'] as const

export function isBatchDecidable(b: { status: string; attestedAt: Date | null }): boolean {
  return (DECIDABLE_BATCH_STATUSES as readonly string[]).includes(b.status) && b.attestedAt !== null
}

export function assertBatchDecidable(b: { status: string; attestedAt: Date | null } | null | undefined): void {
  if (!b || !isBatchDecidable(b)) throw conflict('batch_not_submitted')
}

// Correlated on items.batch_id: usable in any query/UPDATE over `items`.
export const BATCH_DECIDABLE_SQL = sql`EXISTS (SELECT 1 FROM batches b WHERE b.id = ${items.batchId} AND b.status = 'submitted' AND b.attested_at IS NOT NULL)`

export async function decideItem(db: DB, v: Viewer, itemId: number, input: unknown) {
  if (!isReviewer(v)) throw forbidden()
  const d = decisionSchema.safeParse(input)
  if (!d.success) throw badRequest('invalid_decision', { issues: d.error.issues.map((i) => i.message) })
  const it = await db.query.items.findFirst({ where: eq(items.id, itemId) })
  if (!it) throw notFound()
  assertBatchDecidable(await db.query.batches.findFirst({ where: eq(batches.id, it.batchId) }))
  const self = isSelfApproval(v, it)
  if (d.data.decision === 'approve' && d.data.folder !== undefined && it.kind !== 'new_artist') throw badRequest('folder_not_allowed')
  return db.transaction(async (tx) => {
    let rows
    if (d.data.decision === 'approve') {
      const assignable = new Set(await getIntList(db, 'assignable_playlist_ids'))
      const chosen = it.kind === 'new_artist' ? [] : (d.data.playlistIds ?? (await getIntList(db, 'default_playlist_ids')))
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
        // A song needs its probe sha; a new-artist item has no file. Either
        // way the batch must be submitted with the attestation (race-safe).
        .where(and(eq(items.id, it.id), eq(items.status, 'pending'), sql`(${items.kind} = 'new_artist' OR ${items.probeSha256} IS NOT NULL)`, BATCH_DECIDABLE_SQL))
        .returning()
    } else {
      rows = await tx
        .update(items)
        .set({ status: 'denied', denyReason: d.data.reason.trim(), decidedBy: v.discordId, decidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(items.id, it.id), eq(items.status, 'pending'), BATCH_DECIDABLE_SQL))
        .returning()
    }
    const row = oneOrConflict(rows)
    // P3: a song approval enqueues `ingest`; a new-artist approval creates
    // the artists row + folder and ungates the batch's songs.
    if (row.status === 'approved') await afterApprove(tx, row, v, { folder: d.data.decision === 'approve' ? d.data.folder : undefined })
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
    // tickets client each refuse staff comments again. A draft has no ticket
    // yet: its public comments are queued by submitBatch.
    if (row!.visibility === 'all' && b.status !== 'draft') await enqueue(tx, 'ticket_comment', { commentId: row!.id }, { dedupeKey: `ticket_comment:${row!.id}` })
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
    // The effective cover (custom art, else embedded): /api/media/cover/:id.
    coverUrl: mayHaveCover(it) ? signMediaUrl('cover', it.id, v.userId) : null,
  }
}

export async function listOwnItems(db: DB, v: Viewer) {
  const rows = await db.query.items.findMany({ where: eq(items.ownerUserId, v.userId), orderBy: asc(items.id), limit: 200 })
  return rows.map((it) => itemView(v, it))
}

export { getSetting }
