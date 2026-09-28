// Worker job handlers for P2: probe-result collection, ticket open / public
// comment / decision messages, and the daily contract probe. Ingest, moves,
// archive/restore and recovery (P3/P4) plug into the same runner.

import { and, eq, isNull, sql } from 'drizzle-orm'
import { transcodeLabel } from '../lib/fit'
import type { AzuraCastClient } from '../server/azuracast/client'
import { checkContract } from '../server/azuracast/contract'
import { audit } from '../server/audit'
import type { DB } from '../server/db/client'
import { batches, comments, items, memberCache, roleBindings, uploads, users } from '../server/db/schema'
import { enqueue } from '../server/jobs'
import { getQueuesPaused, pauseQueues, resumeQueuesIf } from '../server/pause'
import { MAX_UPLOAD_BYTES, readSpoolResult } from '../server/spool/protocol'
import { TicketsApiError, type TicketsClient } from '../server/tickets/client'

export type WorkerCtx = {
  db: DB
  tickets: TicketsClient
  azuracast: AzuraCastClient
  portalOrigin: string
  spoolOutDir: string
  alert: (title: string, detail: Record<string, unknown>) => Promise<void>
}

// A wait on something outside the job (a ticket not open yet, a busy or
// unavailable tickets bot, a scan window): the job is rescheduled WITHOUT
// spending one of its attempts. It is bounded by AGE instead: once the job is
// older than `maxAgeS` (default 7 days) it goes dead, alerts, and its item or
// request is failed (runJob). The delay grows with the job's age (see
// runJob), so a long outage is polled gently; an `exact` wait (the scan
// window, pacing: the moment it may run is known) is always honoured as
// given, so an old job never lands on the same closed phase every time.
// `Defer` is the same class: P3/P4 "reschedule without an attempt" waits
// should use it.
export const RETRY_MAX_AGE_S = 7 * 24 * 3600
export const TRANSIENT_MAX_AGE_S = 24 * 3600

export class RetryLater extends Error {
  readonly maxAgeS: number
  readonly exact: boolean
  constructor(
    readonly delayS: number,
    message = 'retry later',
    opts: { maxAgeS?: number; exact?: boolean } = {},
  ) {
    super(message)
    this.name = 'RetryLater'
    this.maxAgeS = opts.maxAgeS ?? RETRY_MAX_AGE_S
    this.exact = opts.exact ?? false
  }
}

export { RetryLater as Defer }

export class Permanent extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Permanent'
  }
}

function fromTickets(e: unknown): never {
  if (e instanceof TicketsApiError) {
    // Transient bot/API trouble: a time budget (24 h), not 8 quick tries.
    if (e.retryable) throw new RetryLater(e.retryAfterS ?? 30, `${e.status} ${e.code}`, { maxAgeS: TRANSIENT_MAX_AGE_S })
    throw new Permanent(`${e.status} ${e.code}`)
  }
  throw e
}

// ---------------------------------------------------------- probe results --

// Items in 'probing' get their result from /spool/probe/out (read-only
// mount). Only a result that the probe stamped as coming from the in-web
// inbox with type 'probe' is accepted for an upload item.
//
// Staging accounting (v0.3.0): a WAV the probe converted (or, v0.3.2, an MP3
// it re-encoded to fit) was replaced by its MP3, so the upload row's `length` (what the per-user and global staging
// caps sum) becomes the MP3's size; a rejection whose bytes the probe deleted
// (`released`) marks the upload expired. Both only in the same transaction
// as the item's own probing → pending/rejected transition.
export async function collectProbeResults(ctx: WorkerCtx): Promise<number> {
  const probing = await ctx.db.query.items.findMany({ where: eq(items.status, 'probing'), limit: 50 })
  let n = 0
  for (const it of probing) {
    if (!it.probeRequestId) continue
    let r
    try {
      r = await readSpoolResult(ctx.spoolOutDir, it.probeRequestId)
    } catch {
      r = null
      await ctx.db
        .update(items)
        .set({ status: 'rejected', probeError: 'bad_probe_result', updatedAt: new Date() })
        .where(and(eq(items.id, it.id), eq(items.status, 'probing')))
      continue
    }
    if (!r) continue
    if (r.source !== 'in-web' || r.type !== 'probe') {
      await ctx.db
        .update(items)
        .set({ status: 'rejected', probeError: 'wrong_result_source', updatedAt: new Date() })
        .where(and(eq(items.id, it.id), eq(items.status, 'probing')))
      continue
    }
    if (r.ok && 'sha256' in r) {
      const ok = r
      await ctx.db.transaction(async (tx) => {
        const moved = await tx
          .update(items)
          .set({
            status: 'pending',
            probeSha256: ok.sha256,
            durationS: Math.round(ok.durationS),
            bitrate: ok.bitrate,
            inputFormat: ok.inputFormat ?? 'mp3',
            transcodeKbps: ok.transcodeKbps ?? null,
            prefill: ok.tags,
            title: ok.tags.title,
            artist: ok.tags.artist,
            album: ok.tags.album,
            genre: ok.tags.genre,
            coverFile: ok.cover?.file ?? null,
            coverSha256: ok.cover?.sha256 ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(items.id, it.id), eq(items.status, 'probing')))
          .returning({ id: items.id })
        // Only a plausible MP3 size (what finalize accepts) re-charges the row.
        const replaced = ok.inputFormat === 'wav' || ok.transcodeKbps !== undefined
        if (moved.length === 1 && replaced && it.uploadId && ok.size >= 1 && ok.size <= MAX_UPLOAD_BYTES) {
          await tx.update(uploads).set({ length: ok.size }).where(and(eq(uploads.id, it.uploadId), eq(uploads.status, 'attached')))
        }
      })
    } else {
      const released = !r.ok && 'released' in r && r.released === true
      await ctx.db.transaction(async (tx) => {
        const moved = await tx
          .update(items)
          .set({ status: 'rejected', probeError: 'error' in r ? r.error : 'probe_failed', updatedAt: new Date() })
          .where(and(eq(items.id, it.id), eq(items.status, 'probing')))
          .returning({ id: items.id })
        if (moved.length === 1 && released && it.uploadId) {
          await tx.update(uploads).set({ status: 'expired' }).where(and(eq(uploads.id, it.uploadId), eq(uploads.status, 'attached')))
        }
      })
    }
    n++
  }
  return n
}

// ------------------------------------------------------------- tickets ---

// One card line per pending item (≤ 200 chars). A song the probe encoded (a
// WAV, or an MP3 re-encoded to fit, v0.3.2) says so, so the managers know
// before they listen; the note is kept whole and the name is cut instead.
export function ticketLine(i: Pick<typeof items.$inferSelect, 'id' | 'kind' | 'newArtistName' | 'artist' | 'title' | 'inputFormat' | 'transcodeKbps'>): string {
  if (i.kind === 'new_artist') return `#${i.id} New artist: ${i.newArtistName ?? '?'}`.slice(0, 200)
  const note = transcodeLabel(i.inputFormat, i.transcodeKbps)
  const suffix = note ? ` (${note})` : ''
  return `#${i.id} ${i.artist ?? '?'} - ${i.title ?? '?'}`.slice(0, 200 - suffix.length) + suffix
}

export async function ticketOpen(ctx: WorkerCtx, payload: { batchId: number }) {
  const b = await ctx.db.query.batches.findFirst({ where: eq(batches.id, payload.batchId) })
  if (!b) throw new Permanent('batch missing')
  if (b.ticketId) return
  const owner = await ctx.db.query.users.findFirst({ where: eq(users.id, b.ownerUserId) })
  if (!owner) throw new Permanent('owner missing')
  const its = await ctx.db.query.items.findMany({ where: eq(items.batchId, b.id) })
  const lines = its
    .filter((i) => i.status === 'pending')
    .slice(0, 24)
    .map(ticketLine)
  let res
  try {
    res = await ctx.tickets.openTicket({
      categoryKey: 'newsong',
      openerDiscordId: owner.discordId,
      subject: `Music submission #${b.id}`,
      card: { title: `Batch #${b.id}: ${lines.length} song(s)`, lines, link: { label: 'Open in portal', url: `${ctx.portalOrigin}/batches/${b.id}` } },
      externalRef: `batch:${b.id}`,
    })
  } catch (e) {
    fromTickets(e)
  }
  await ctx.db
    .update(batches)
    .set({ ticketId: res.ticketId, ticketNumber: res.number, ticketWebUrl: res.webUrl, ticketChannelUrl: res.discordChannelUrl, ticketStatus: 'open', updatedAt: new Date() })
    .where(and(eq(batches.id, b.id), isNull(batches.ticketId)))
  await audit(ctx.db, { action: 'ticket.opened', targetType: 'batch', targetId: b.id, detail: { ticketId: res.ticketId, created: res.created } })
  // Comment / decision jobs of this batch that were waiting for the ticket
  // run now instead of at their next back-off.
  await ctx.db.execute(sql`
    UPDATE jobs SET run_after = now(), updated_at = now()
    WHERE status = 'queued' AND (
      (kind = 'ticket_comment' AND (payload->>'commentId') IN (SELECT id::text FROM comments WHERE batch_id = ${b.id}))
      OR (kind = 'ticket_decision' AND (payload->>'itemId') IN (SELECT id::text FROM items WHERE batch_id = ${b.id})))`)
}

// Staff comments are never forwarded. Checked here against the DB row (not
// the job payload), and again inside TicketsClient.postComment.
export async function ticketComment(ctx: WorkerCtx, payload: { commentId: number }) {
  const c = await ctx.db.query.comments.findFirst({ where: eq(comments.id, payload.commentId) })
  if (!c) throw new Permanent('comment missing')
  if (c.visibility !== 'all' || c.source !== 'portal') return
  if (c.ticketMessageId) return
  if (!c.batchId) throw new Permanent('comment without batch')
  const b = await ctx.db.query.batches.findFirst({ where: eq(batches.id, c.batchId) })
  if (!b?.ticketId) throw new RetryLater(60, 'ticket not open yet')
  const asActor = await mayActAs(ctx, b.ownerUserId, c.authorDiscordId)
  const input = { id: c.id, visibility: c.visibility, body: c.body, itemId: c.itemId, authorDiscordId: c.authorDiscordId, authorName: c.authorName }
  let res
  try {
    res = await ctx.tickets.postComment(b.ticketId, input, { asActor })
  } catch (e) {
    if (!(asActor && e instanceof TicketsApiError && e.status === 403 && e.code === 'actor_forbidden')) fromTickets(e)
    // The tickets staff set disagrees with ours: post once as the
    // integration, with the author's name, so the comment is never lost.
    await audit(ctx.db, { action: 'comment.actor_fallback', targetType: 'comment', targetId: c.id, detail: { ticketId: b.ticketId, actorDiscordId: c.authorDiscordId } })
    try {
      res = await ctx.tickets.postComment(b.ticketId, input, { asActor: false })
    } catch (e2) {
      fromTickets(e2)
    }
  }
  await ctx.db.update(comments).set({ ticketMessageId: res.messageId }).where(eq(comments.id, c.id))
}

// Whether to post a portal comment AS its author (actorDiscordId). The
// tickets API accepts an actor only if it is the ticket's opener or a
// non-pending member in the category staff set (INTEGRATION_API v0.12.2).
// The portal's side of that: the batch owner (the opener), or a member whose
// cached roles include a role_bindings role (the reviewer roles, which are
// the newsong/songedit/songremoval staff roles). Admin-by-PORTAL_OWNER_IDS
// alone is NOT a staff role. A mismatch still falls back (see above).
async function mayActAs(ctx: WorkerCtx, batchOwnerUserId: string, authorDiscordId: string | null): Promise<boolean> {
  if (!authorDiscordId) return false
  const owner = await ctx.db.query.users.findFirst({ where: eq(users.id, batchOwnerUserId) })
  if (owner?.discordId === authorDiscordId) return true
  const mc = await ctx.db.query.memberCache.findFirst({ where: eq(memberCache.discordId, authorDiscordId) })
  if (!mc || !mc.member || mc.pending) return false
  const bound = new Set((await ctx.db.select({ roleId: roleBindings.roleId }).from(roleBindings)).map((r) => r.roleId))
  return mc.roleIds.some((r) => bound.has(r))
}

export async function ticketDecision(ctx: WorkerCtx, payload: { itemId: number }) {
  const it = await ctx.db.query.items.findFirst({ where: eq(items.id, payload.itemId) })
  if (!it) throw new Permanent('item missing')
  if (it.status !== 'approved' && it.status !== 'denied') return
  const b = await ctx.db.query.batches.findFirst({ where: eq(batches.id, it.batchId) })
  if (!b?.ticketId) throw new RetryLater(60, 'ticket not open yet')
  const name = it.kind === 'new_artist' ? `new artist ${it.newArtistName ?? '?'}` : `${it.artist ?? '?'} - ${it.title ?? '?'}`
  const body = it.status === 'approved' ? `Approved: ${name}` : `Denied: ${name}\nReason: ${it.denyReason ?? ''}`
  try {
    await ctx.tickets.postMessage(b.ticketId, { kind: 'system', body: body.slice(0, 1800), itemRef: `item:${it.id}` }, `decision:item:${it.id}:${it.status}`)
  } catch (e) {
    fromTickets(e)
  }
}

// --------------------------------------------------------- contract probe --

// Runs at start-up and daily. FAILS CLOSED: if the spec cannot be fetched or
// checked, the mutating queues are paused with reason 'contract_unverified'
// (and a retry is scheduled); on drift they are paused with 'contract_drift'.
// Only a 'contract_unverified' pause is lifted automatically, by a later
// successful probe. Never throws (a thrown probe would retry, then die, and
// leave the queues running).
export async function contractProbe(ctx: WorkerCtx): Promise<boolean> {
  let report: ReturnType<typeof checkContract>
  try {
    const spec = await ctx.azuracast.openapi()
    report = checkContract(spec)
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'error'
    const current = await getQueuesPaused(ctx.db)
    // Never replace a stronger reason (drift, an operator pause) with this one.
    if (!current) await pauseQueues(ctx.db, 'contract_unverified', { error })
    const retryAt = new Date(Date.now() + 15 * 60_000)
    await enqueue(ctx.db, 'contract_probe', {}, { dedupeKey: `contract_probe:retry:${retryAt.toISOString().slice(0, 15)}`, runAfter: retryAt })
    await ctx.alert('AzuraCast contract could not be verified: mutating jobs (ingest, move, archive, restore, edits) are paused; retrying in 15 min', {
      error,
      pausedReason: current?.reason ?? 'contract_unverified',
    })
    return false
  }
  if (report.ok) {
    // Daily re-run of the key self-check: a key that gained access to a
    // canary station (or lost its own) pauses the mutating queues. Not
    // auto-cleared: an operator must look at the key.
    try {
      await ctx.azuracast.selfCheck()
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'error'
      const value = await pauseQueues(ctx.db, 'self_check_failed', { error })
      await ctx.alert('AzuraCast key self-check failed: mutating jobs are paused until an operator clears settings.queues_paused', value)
      return false
    }
    if (await resumeQueuesIf(ctx.db, 'contract_unverified')) {
      await ctx.alert('AzuraCast contract verified again: mutating jobs resumed', {})
    }
    return true
  }
  const value = await pauseQueues(ctx.db, 'contract_drift', { drift: report.drift.slice(0, 20) })
  await audit(ctx.db, { action: 'contract.drift', detail: value })
  await ctx.alert('AzuraCast contract drift: mutating jobs (ingest, move, archive, restore, edits) are paused until an operator clears settings.queues_paused', value)
  return false
}
