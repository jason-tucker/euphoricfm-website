// Read-only page queries for the portal UI. Every function takes the Viewer
// from requirePermission() and applies the plan §3.3 predicates itself, the
// same way src/server/submissions.ts does: rows the viewer may not see are
// 404, and elevated views re-check the permission. Nothing here writes.

import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { canViewOwned, isReviewer, type Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { batches, comments, items, jobs, libraryCache, requests, roleBindings, settings, uploads, users } from '../db/schema'
import { forbidden, notFound } from '../http/errors'
import { REQUEST_OPEN_STATUSES } from '../requests/common'
import { BATCH_DECIDABLE_SQL } from '../submissions'
import { customArtIdOf, itemCoverUrl, itemHasArt, libraryArt } from './art'
import { escapeLike, onLibrarySurface } from './library'

type ItemRow = typeof items.$inferSelect

// What the UI shows about an item. Reviewer-only fields are added only for
// reviewers (mirrors submissions.itemView).
export function uiItem(v: Viewer, it: ItemRow) {
  return {
    id: it.id,
    batchId: it.batchId,
    kind: it.kind,
    source: it.source,
    status: it.status,
    title: it.title,
    artist: it.artist,
    album: it.album,
    genre: it.genre,
    newArtistName: it.newArtistName,
    durationS: it.durationS,
    bitrate: it.bitrate,
    prefill: (it.prefill ?? null) as Record<string, string | null> | null,
    probeError: it.probeError,
    denyReason: it.denyReason,
    // 'wav' = uploaded as a WAV and converted to an MP3 (v0.3.0);
    // transcodeKbps = the bitrate the probe encoded it at (a WAV, or an MP3
    // re-encoded to fit, v0.3.5), null = the member's own MP3, untouched.
    inputFormat: it.inputFormat,
    transcodeKbps: it.transcodeKbps,
    hasCover: Boolean(it.coverFile),
    hasArt: itemHasArt(it),
    hasCustomArt: customArtIdOf(it) !== null,
    coverUrl: itemCoverUrl(v.userId, it),
    playlistIds: it.playlistIds,
    decidedAt: it.decidedAt?.toISOString() ?? null,
    liveAt: it.liveAt?.toISOString() ?? null,
    createdAt: it.createdAt.toISOString(),
    isOwn: it.ownerUserId === v.userId,
    ...(isReviewer(v) ? { selfApproved: it.selfApproved, decidedBy: it.decidedBy } : {}),
  }
}
export type UiItem = ReturnType<typeof uiItem>

function ticketOf(b: typeof batches.$inferSelect) {
  return b.ticketId ? { number: b.ticketNumber, webUrl: b.ticketWebUrl, channelUrl: b.ticketChannelUrl, status: b.ticketStatus } : null
}
export type UiTicket = ReturnType<typeof ticketOf>

// ----------------------------------------------------------- dashboard ---

export async function listOwnBatches(db: DB, v: Viewer, limit = 50) {
  const bs = await db.query.batches.findMany({ where: eq(batches.ownerUserId, v.userId), orderBy: desc(batches.id), limit })
  if (bs.length === 0) return []
  const its = await db.query.items.findMany({
    where: and(eq(items.ownerUserId, v.userId), inArray(items.batchId, bs.map((b) => b.id))),
    orderBy: asc(items.id),
  })
  return bs.map((b) => ({
    id: b.id,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    submittedAt: b.submittedAt?.toISOString() ?? null,
    ticket: ticketOf(b),
    items: its.filter((i) => i.batchId === b.id).map((i) => uiItem(v, i)),
  }))
}

export async function listOwnRequests(db: DB, v: Viewer, limit = 50) {
  const rows = await db.query.requests.findMany({ where: eq(requests.ownerUserId, v.userId), orderBy: desc(requests.id), limit })
  const ids = [...new Set(rows.map((r) => r.mediaId))]
  const [art, lib] = await Promise.all([
    libraryArt(db, ids),
    ids.length ? db.select({ mediaId: libraryCache.mediaId, path: libraryCache.path }).from(libraryCache).where(inArray(libraryCache.mediaId, ids)) : [],
  ])
  // Songs whose library page exists (librarySong 404s the rest, e.g. one
  // archived by another request), so the dashboard only links those.
  const onLibrary = new Set(lib.filter((l) => onLibrarySurface(l.path)).map((l) => l.mediaId))
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    mediaId: r.mediaId,
    targetPath: r.targetPath,
    proposed: (r.proposed ?? null) as Record<string, unknown> | null,
    reason: r.reason,
    denyReason: r.denyReason,
    error: r.error,
    awaitingArtist: r.pendingArtistId !== null,
    artUrl: art.get(r.mediaId) ?? null,
    onLibrary: onLibrary.has(r.mediaId),
    createdAt: r.createdAt.toISOString(),
    ticket: r.ticketId ? { number: r.ticketNumber, webUrl: r.ticketWebUrl, channelUrl: r.ticketChannelUrl, status: r.ticketStatus } : null,
  }))
}

// ------------------------------------------------------ home counters ---

// The member's OWN counts for the home page and dashboard: songs waiting for
// a decision (pending in a submitted batch, like the review queue), songs on
// air, and edit/removal requests still open. Songs only: a batch's
// new-artist items are not counted.
export async function memberSummary(db: DB, v: Viewer) {
  const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0)
  const [inReview, onAir, openRequests] = await Promise.all([
    db.select({ n: count() }).from(items).where(and(eq(items.ownerUserId, v.userId), eq(items.kind, 'song'), eq(items.status, 'pending'), BATCH_DECIDABLE_SQL)),
    db.select({ n: count() }).from(items).where(and(eq(items.ownerUserId, v.userId), eq(items.kind, 'song'), eq(items.status, 'live'))),
    db.select({ n: count() }).from(requests).where(and(eq(requests.ownerUserId, v.userId), inArray(requests.status, [...REQUEST_OPEN_STATUSES]))),
  ])
  return { inReview: n(inReview), onAir: n(onAir), openRequests: n(openRequests) }
}
export type MemberSummary = Awaited<ReturnType<typeof memberSummary>>

// What is waiting for reviewers: decidable songs (new-artist items travel
// with a song in the same batch) and pending requests.
export async function reviewSummary(db: DB, v: Viewer) {
  if (!isReviewer(v)) throw forbidden()
  const [songs, reqs] = await Promise.all([
    db.select({ n: count() }).from(items).where(and(eq(items.kind, 'song'), eq(items.status, 'pending'), BATCH_DECIDABLE_SQL)),
    db.select({ n: count() }).from(requests).where(eq(requests.status, 'pending')),
  ])
  return { songs: Number(songs[0]?.n ?? 0), requests: Number(reqs[0]?.n ?? 0) }
}
export type ReviewSummary = Awaited<ReturnType<typeof reviewSummary>>

// -------------------------------------------------------- batch detail ---

export async function batchDetail(db: DB, v: Viewer, id: number) {
  const b = await db.query.batches.findFirst({ where: eq(batches.id, id) })
  if (!b || !canViewOwned(v, b)) throw notFound()
  const its = await db.query.items.findMany({ where: eq(items.batchId, b.id), orderBy: asc(items.id) })
  const owner = isReviewer(v) ? await db.query.users.findFirst({ where: eq(users.id, b.ownerUserId) }) : null
  return {
    id: b.id,
    status: b.status,
    isOwn: b.ownerUserId === v.userId,
    ownerName: owner ? (owner.name ?? owner.discordId) : null,
    createdAt: b.createdAt.toISOString(),
    submittedAt: b.submittedAt?.toISOString() ?? null,
    ticket: ticketOf(b),
    items: its.map((i) => uiItem(v, i)),
  }
}

// ---------------------------------------------------------- review queue --

export type QueueFilters = { q?: string; kind?: 'song' | 'new_artist'; source?: 'upload' | 'soundcloud'; mine?: boolean; batchId?: number }

export async function reviewQueue(db: DB, v: Viewer, f: QueueFilters = {}) {
  if (!isReviewer(v)) throw forbidden()
  // Only items a reviewer may decide: pending, in a batch submitted WITH the
  // rights attestation (the same predicate decideItem's UPDATE uses), so a
  // member's unsubmitted draft never shows up in the queue.
  const conds = [eq(items.status, 'pending'), BATCH_DECIDABLE_SQL]
  if (f.kind) conds.push(eq(items.kind, f.kind))
  if (f.source) conds.push(eq(items.source, f.source))
  if (f.mine) conds.push(eq(items.ownerUserId, v.userId))
  if (f.batchId) conds.push(eq(items.batchId, f.batchId))
  if (f.q) {
    const pat = `%${escapeLike(f.q)}%`
    conds.push(or(ilike(items.title, pat), ilike(items.artist, pat), ilike(items.newArtistName, pat), ilike(users.name, pat))!)
  }
  const rows = await db
    .select({ item: items, batchSubmittedAt: batches.submittedAt, ticket: batches.ticketNumber, ownerName: users.name, ownerDiscordId: users.discordId })
    .from(items)
    .innerJoin(batches, eq(batches.id, items.batchId))
    .innerJoin(users, eq(users.id, items.ownerUserId))
    .where(and(...conds))
    // Oldest first: by batch submission time, then item order in the batch.
    .orderBy(asc(batches.submittedAt), asc(items.batchId), asc(items.id))
    .limit(300)
  const groups = new Map<number, { batchId: number; submittedAt: string | null; ownerName: string; ticketNumber: number | null; items: UiItem[] }>()
  for (const r of rows) {
    let g = groups.get(r.item.batchId)
    if (!g) {
      g = {
        batchId: r.item.batchId,
        submittedAt: r.batchSubmittedAt?.toISOString() ?? null,
        ownerName: r.ownerName ?? r.ownerDiscordId,
        ticketNumber: r.ticket,
        items: [],
      }
      groups.set(r.item.batchId, g)
    }
    g.items.push(uiItem(v, r.item))
  }
  return [...groups.values()]
}

export async function reviewItem(db: DB, v: Viewer, id: number) {
  if (!isReviewer(v)) throw forbidden()
  const it = await db.query.items.findFirst({ where: eq(items.id, id) })
  if (!it) throw notFound()
  const b = await db.query.batches.findFirst({ where: eq(batches.id, it.batchId) })
  // A draft (never submitted / attested) batch is still the member's: it is
  // not on the review surface at all (the queue filters it the same way).
  if (!b || b.status === 'draft' || b.attestedAt === null) throw notFound()
  const owner = await db.query.users.findFirst({ where: eq(users.id, it.ownerUserId) })
  const siblings = await db
    .select({ id: items.id, status: items.status, title: items.title, artist: items.artist, kind: items.kind })
    .from(items)
    .where(eq(items.batchId, b.id))
    .orderBy(asc(items.id))
  return {
    item: uiItem(v, it),
    batch: { id: b.id, status: b.status, submittedAt: b.submittedAt?.toISOString() ?? null, ticket: ticketOf(b) },
    ownerName: owner ? (owner.name ?? owner.discordId) : '(unknown)',
    siblings,
  }
}

// ---------------------------------------------------------------- admin --

export async function adminOverview(db: DB, v: Viewer) {
  if (!v.perms.has('admin')) throw forbidden()
  const [bindings, settingRows, itemCounts, jobCounts, inflight, pendingComments] = await Promise.all([
    db.select().from(roleBindings).orderBy(asc(roleBindings.roleId), asc(roleBindings.permission)),
    db.select().from(settings).orderBy(asc(settings.key)),
    db.select({ status: items.status, n: count() }).from(items).groupBy(items.status),
    db.select({ status: jobs.status, n: count() }).from(jobs).groupBy(jobs.status),
    db.select({ n: count(), bytes: sql<string>`COALESCE(SUM(${uploads.length}), 0)::bigint` }).from(uploads).where(eq(uploads.status, 'uploading')),
    db.select({ n: count() }).from(comments).where(and(eq(comments.visibility, 'all'), eq(comments.source, 'portal'), sql`${comments.ticketMessageId} IS NULL`)),
  ])
  return {
    bindings: bindings.map((b) => ({ id: b.id, roleId: b.roleId, permission: b.permission as 'review' | 'manage', note: b.note, createdBy: b.createdBy, createdAt: b.createdAt.toISOString() })),
    settings: settingRows.map((s) => ({ key: s.key, value: s.value, updatedAt: s.updatedAt.toISOString(), updatedBy: s.updatedBy })),
    itemCounts: Object.fromEntries(itemCounts.map((r) => [r.status, Number(r.n)])),
    jobCounts: Object.fromEntries(jobCounts.map((r) => [r.status, Number(r.n)])),
    uploadsInFlight: { n: Number(inflight[0]?.n ?? 0), bytes: Number(inflight[0]?.bytes ?? 0) },
    unsentPublicComments: Number(pendingComments[0]?.n ?? 0),
  }
}
