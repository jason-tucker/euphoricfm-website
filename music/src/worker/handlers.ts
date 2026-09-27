// Worker job handlers for P2: probe-result collection, ticket open / public
// comment / decision messages, and the daily contract probe. Ingest, moves,
// archive/restore and recovery (P3/P4) plug into the same runner.

import { and, eq, isNull } from 'drizzle-orm'
import type { AzuraCastClient } from '../server/azuracast/client'
import { checkContract } from '../server/azuracast/contract'
import { audit } from '../server/audit'
import type { DB } from '../server/db/client'
import { batches, comments, items, users } from '../server/db/schema'
import { enqueue } from '../server/jobs'
import { getQueuesPaused, pauseQueues, resumeQueuesIf } from '../server/pause'
import { readSpoolResult } from '../server/spool/protocol'
import { TicketsApiError, type TicketsClient } from '../server/tickets/client'

export type WorkerCtx = {
  db: DB
  tickets: TicketsClient
  azuracast: AzuraCastClient
  portalOrigin: string
  spoolOutDir: string
  alert: (title: string, detail: Record<string, unknown>) => Promise<void>
}

export class RetryLater extends Error {
  constructor(readonly delayS: number, message = 'retry later') {
    super(message)
    this.name = 'RetryLater'
  }
}

export class Permanent extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Permanent'
  }
}

function fromTickets(e: unknown): never {
  if (e instanceof TicketsApiError) {
    if (e.retryable) throw new RetryLater(e.retryAfterS ?? 30, `${e.status} ${e.code}`)
    throw new Permanent(`${e.status} ${e.code}`)
  }
  throw e
}

// ---------------------------------------------------------- probe results --

// Items in 'probing' get their result from /spool/probe/out (read-only
// mount). Only a result that the probe stamped as coming from the in-web
// inbox with type 'probe' is accepted for an upload item.
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
      await ctx.db
        .update(items)
        .set({
          status: 'pending',
          probeSha256: r.sha256,
          durationS: Math.round(r.durationS),
          bitrate: r.bitrate,
          prefill: r.tags,
          title: r.tags.title,
          artist: r.tags.artist,
          album: r.tags.album,
          genre: r.tags.genre,
          coverFile: r.cover?.file ?? null,
          coverSha256: r.cover?.sha256 ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(items.id, it.id), eq(items.status, 'probing')))
    } else {
      await ctx.db
        .update(items)
        .set({ status: 'rejected', probeError: 'error' in r ? r.error : 'probe_failed', updatedAt: new Date() })
        .where(and(eq(items.id, it.id), eq(items.status, 'probing')))
    }
    n++
  }
  return n
}

// ------------------------------------------------------------- tickets ---

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
    .map((i) => `#${i.id} ${i.artist ?? '?'} - ${i.title ?? '?'}`.slice(0, 200))
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
  let res
  try {
    res = await ctx.tickets.postComment(b.ticketId, { id: c.id, visibility: c.visibility, body: c.body, itemId: c.itemId, authorDiscordId: c.authorDiscordId })
  } catch (e) {
    fromTickets(e)
  }
  await ctx.db.update(comments).set({ ticketMessageId: res.messageId }).where(eq(comments.id, c.id))
}

export async function ticketDecision(ctx: WorkerCtx, payload: { itemId: number }) {
  const it = await ctx.db.query.items.findFirst({ where: eq(items.id, payload.itemId) })
  if (!it) throw new Permanent('item missing')
  if (it.status !== 'approved' && it.status !== 'denied') return
  const b = await ctx.db.query.batches.findFirst({ where: eq(batches.id, it.batchId) })
  if (!b?.ticketId) throw new RetryLater(60, 'ticket not open yet')
  const name = `${it.artist ?? '?'} - ${it.title ?? '?'}`
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
