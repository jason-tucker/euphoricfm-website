// Edit and removal requests (plan §0, §3.3, §6 P4). Any member (`request`)
// files one; each opens its own ticket (worker job). Reviewers approve or
// deny with a conditional UPDATE (409 on a race); an approval queues the
// worker's apply_edit or archive. Every action is audited.

import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit'
import { canViewOwned, isOwner, isReviewer, isSelfApproval, type Viewer } from '../authz/predicates'
import { oneOrConflict } from '../authz/transitions'
import type { DB } from '../db/client'
import { archive, artists, libraryCache, requests } from '../db/schema'
import { badRequest, forbidden, HttpError, notFound } from '../http/errors'
import { enqueue } from '../jobs'
import { getSetting } from '../settings'
import { isUsableArt, loadArt } from '../library/art'
import {
  applyProposed,
  DEFAULT_REQUEST_CAPS,
  freeText,
  isRequestTarget,
  META_KEYS,
  metaOf,
  ProposedSchema,
  REQUEST_OPEN_STATUSES,
  sameMeta,
} from './common'

const mediaId = z.number().int().positive().max(2_147_483_647)

const fileSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('edit'),
      mediaId,
      proposed: ProposedSchema,
      reason: freeText(1000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('removal'),
      mediaId,
      reason: freeText(1000).refine((s) => s.length > 0, 'reason required'),
    })
    .strict(),
])

const capsSchema = z.object({ edit: z.number().int().min(0).max(1000), removal: z.number().int().min(0).max(1000) }).strict()

export async function dailyCaps(db: DB) {
  return dailyCapsOf(await getSetting(db, 'request_daily_caps'))
}

export function dailyCapsOf(v: unknown): { edit: number; removal: number } {
  const r = capsSchema.safeParse(v)
  return r.success ? r.data : DEFAULT_REQUEST_CAPS
}

// The target must be a cached library row inside the whitelist, and not
// archived. Anything else is "not found" (no probing of other paths).
export async function loadRequestTarget(db: DB, root: string, id: number) {
  const lib = await db.query.libraryCache.findFirst({ where: eq(libraryCache.mediaId, id) })
  if (!lib || !isRequestTarget(root, lib.path)) throw notFound()
  // Archived, or a restore still in progress. (An 'archiving' row that
  // stopped part way stays actionable, so a manager can queue the archive
  // again and the worker resumes it.)
  const archived = await db.query.archive.findFirst({ where: and(eq(archive.mediaId, id), inArray(archive.status, ['archived', 'restoring'])) })
  if (archived) throw notFound()
  return lib
}

export function requestView(v: Viewer, r: typeof requests.$inferSelect) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    mediaId: r.mediaId,
    targetPath: r.targetPath,
    proposed: r.proposed as Record<string, string> | null,
    current: r.snapshot as Record<string, unknown> | null,
    reason: r.reason,
    denyReason: r.denyReason,
    error: r.error,
    awaitingArtistId: r.pendingArtistId,
    ticket: r.ticketId ? { number: r.ticketNumber, webUrl: r.ticketWebUrl, discordChannelUrl: r.ticketChannelUrl, status: r.ticketStatus } : null,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    appliedAt: r.appliedAt?.toISOString() ?? null,
    ...(isReviewer(v) ? { decidedBy: r.decidedBy, isOwn: r.ownerUserId === v.userId } : {}),
  }
}

export async function fileRequest(db: DB, v: Viewer, root: string, input: unknown) {
  if (!v.perms.has('request')) throw forbidden()
  const p = fileSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_request', { issues: p.error.issues.map((i) => i.message) })
  const d = p.data
  const lib = await loadRequestTarget(db, root, d.mediaId)
  const current = metaOf(lib)
  let proposed: Record<string, string> | null = null
  if (d.kind === 'edit') {
    const artId = d.proposed.artId
    // Proposed art must be a ready upload of the member's own.
    if (artId !== undefined) {
      const art = await loadArt(db, artId)
      if (!isUsableArt(art) || art.owner !== v.userId) throw badRequest('art_not_ready')
    }
    const next = applyProposed(current, d.proposed)
    if (sameMeta(next, current) && artId === undefined) throw badRequest('no_change')
    // Store only the fields that actually change (plus the art, if any).
    proposed = {}
    for (const k of META_KEYS) if (d.proposed[k] !== undefined && d.proposed[k] !== current[k]) proposed[k] = d.proposed[k]!
    if (artId !== undefined) proposed.artId = artId
  }
  const caps = await dailyCaps(db)
  return db.transaction(async (tx) => {
    // Serialise one user's filings so the daily cap cannot be raced.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'requests:' + v.userId}))`)
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(requests)
      .where(and(eq(requests.ownerUserId, v.userId), eq(requests.kind, d.kind), gt(requests.createdAt, sql`now() - interval '1 day'`)))
    if (n >= caps[d.kind]) throw new HttpError(429, 'daily_cap', { limit: caps[d.kind] })
    const dup = await tx.query.requests.findFirst({
      where: and(
        eq(requests.ownerUserId, v.userId),
        eq(requests.mediaId, lib.mediaId),
        eq(requests.kind, d.kind),
        inArray(requests.status, [...REQUEST_OPEN_STATUSES]),
      ),
    })
    if (dup) throw new HttpError(409, 'duplicate_request', { id: dup.id })
    const [row] = await tx
      .insert(requests)
      .values({
        ownerUserId: v.userId,
        kind: d.kind,
        mediaId: lib.mediaId,
        targetPath: lib.path,
        proposed,
        reason: d.reason || null,
        snapshot: { path: lib.path, ...current, playlistIds: lib.playlistIds },
        status: 'pending',
      })
      .returning()
    await enqueue(tx, 'request_ticket_open', { requestId: row!.id }, { dedupeKey: `request_ticket_open:${row!.id}` })
    await audit(tx, {
      actorUserId: v.userId,
      actorDiscordId: v.discordId,
      action: `request.file_${d.kind}`,
      targetType: 'request',
      targetId: row!.id,
      detail: { mediaId: lib.mediaId, path: lib.path, proposed },
    })
    return { id: row!.id, kind: row!.kind, status: row!.status }
  })
}

export async function listOwnRequests(db: DB, v: Viewer) {
  const rows = await db.query.requests.findMany({ where: eq(requests.ownerUserId, v.userId), orderBy: desc(requests.id), limit: 200 })
  return rows.map((r) => requestView(v, r))
}

export async function getRequest(db: DB, v: Viewer, id: number) {
  const r = await db.query.requests.findFirst({ where: eq(requests.id, id) })
  if (!r || !canViewOwned(v, r)) throw notFound()
  return requestView(v, r)
}

export async function withdrawRequest(db: DB, v: Viewer, id: number) {
  const r = await db.query.requests.findFirst({ where: eq(requests.id, id) })
  if (!r || !canViewOwned(v, r)) throw notFound()
  if (!isOwner(v, r)) throw forbidden()
  return db.transaction(async (tx) => {
    const row = oneOrConflict(
      await tx
        .update(requests)
        .set({ status: 'withdrawn', updatedAt: new Date() })
        .where(and(eq(requests.id, r.id), eq(requests.ownerUserId, v.userId), eq(requests.status, 'pending')))
        .returning(),
    )
    await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'request.withdraw', targetType: 'request', targetId: r.id })
    return { id: row.id, status: row.status }
  })
}

const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('deny'), reason: freeText(500).refine((s) => s.length > 0, 'reason required') }).strict(),
])

export async function decideRequest(db: DB, v: Viewer, id: number, input: unknown) {
  if (!isReviewer(v)) throw forbidden()
  const d = decisionSchema.safeParse(input)
  if (!d.success) throw badRequest('invalid_decision', { issues: d.error.issues.map((i) => i.message) })
  const r = await db.query.requests.findFirst({ where: eq(requests.id, id) })
  if (!r) throw notFound()
  const self = isSelfApproval(v, r)
  return db.transaction(async (tx) => {
    const approve = d.data.decision === 'approve'
    const row = oneOrConflict(
      await tx
        .update(requests)
        .set({
          status: approve ? 'approved' : 'denied',
          denyReason: approve ? null : (d.data as { reason: string }).reason,
          decidedBy: v.discordId,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(requests.id, r.id), eq(requests.status, 'pending')))
        .returning(),
    )
    if (approve) {
      const kind = row.kind === 'edit' ? 'apply_edit' : 'archive'
      await enqueue(tx, kind, { requestId: row.id }, { dedupeKey: `${kind}:request:${row.id}` })
    }
    await enqueue(tx, 'request_ticket_post', { requestId: row.id, event: row.status }, { dedupeKey: `request_ticket_post:${row.id}:${row.status}` })
    await audit(tx, {
      actorUserId: v.userId,
      actorDiscordId: v.discordId,
      action: `request.${approve ? 'approve' : 'deny'}`,
      targetType: 'request',
      targetId: row.id,
      detail: { selfApproved: self, kind: row.kind, mediaId: row.mediaId },
    })
    return { id: row.id, status: row.status, selfApproved: self }
  })
}

// New-artist approval for an edit that renames the main artist to one the
// library does not have yet: the worker created the artists row as
// 'pending' and parked the request on it. Only artists some request waits
// on can be decided here (batch new-artist items have their own flow).
const artistDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('deny'), reason: freeText(500).refine((s) => s.length > 0, 'reason required') }).strict(),
])

export async function decideRequestArtist(db: DB, v: Viewer, artistId: number, input: unknown) {
  if (!isReviewer(v)) throw forbidden()
  const d = artistDecisionSchema.safeParse(input)
  if (!d.success) throw badRequest('invalid_decision', { issues: d.error.issues.map((i) => i.message) })
  const waiting = await db.query.requests.findFirst({ where: eq(requests.pendingArtistId, artistId) })
  if (!waiting) throw notFound()
  return db.transaction(async (tx) => {
    const status = d.data.decision === 'approve' ? 'active' : 'denied'
    const row = oneOrConflict(
      await tx
        .update(artists)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(artists.id, artistId), eq(artists.status, 'pending')))
        .returning(),
    )
    await audit(tx, {
      actorUserId: v.userId,
      actorDiscordId: v.discordId,
      action: `artist.${status === 'active' ? 'approve' : 'deny'}`,
      targetType: 'artist',
      targetId: row.id,
      detail: { name: row.name, folder: row.folder, via: 'request', ...(status === 'denied' ? { reason: (d.data as { reason: string }).reason } : {}) },
    })
    // The worker's sweep resumes (or fails) every request parked on it.
    return { id: row.id, status: row.status, folder: row.folder }
  })
}
