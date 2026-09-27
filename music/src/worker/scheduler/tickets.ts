// Ticket posts for P3 (the approve/deny posts are P2's ticket_decision job):
//
//  * ticket_item_event   ingest done ("live") / ingest failed, per item
//  * batch_summary       once every item of a submitted batch is decided:
//                        one summary message, then PATCH `completed`
//  * ticket_autoclose    `auto_close_days` (7) without activity since the
//                        batch completed → PATCH `closed` (tickets:close)
//
// Every post carries a deterministic Idempotency-Key, so a retried job never
// double-posts. System messages only: staff comments never pass through here.

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { audit } from '../../server/audit'
import { batches, items } from '../../server/db/schema'
import { enqueue } from '../../server/jobs'
import { getSetting } from '../../server/settings'
import { TicketsApiError } from '../../server/tickets/client'
import { Defer, Permanent, RetryLater } from '../handlers'
import type { P3Ctx } from '../ingest/context'

const UNDECIDED = ['probing', 'draft', 'pending'] as const

function mapTicketsError(e: unknown): never {
  if (e instanceof TicketsApiError) {
    if (e.retryable) throw new RetryLater(e.retryAfterS ?? 30, `${e.status} ${e.code}`)
    throw new Permanent(`${e.status} ${e.code}`)
  }
  throw e
}

const isClosedError = (e: unknown) => e instanceof TicketsApiError && e.status === 409 && (e.code === 'ticket_closed' || e.code === 'already_closed')

type Item = typeof items.$inferSelect

function itemName(it: Item): string {
  return it.kind === 'new_artist' ? `new artist ${it.newArtistName ?? '?'}` : `${it.artist ?? '?'} - ${it.title ?? '?'}`
}

// ---------------------------------------------------------- item events --

export async function ticketItemEvent(ctx: P3Ctx, payload: { itemId: number; event: 'live' | 'failed' }) {
  if (payload.event !== 'live' && payload.event !== 'failed') throw new Permanent('bad event')
  const it = await ctx.db.query.items.findFirst({ where: eq(items.id, payload.itemId) })
  if (!it) throw new Permanent('item missing')
  const b = await ctx.db.query.batches.findFirst({ where: eq(batches.id, it.batchId) })
  if (!b?.ticketId) throw new RetryLater(60, 'ticket not open yet')
  const body =
    payload.event === 'live'
      ? `Added to the station: ${itemName(it)} (song #${it.id}).`
      : `Could not add ${itemName(it)} (song #${it.id}) to the station. The team has been alerted and will follow up.`
  try {
    await ctx.tickets.postMessage(b.ticketId, { kind: 'system', body: body.slice(0, 1800), itemRef: `item:${it.id}` }, `ingest:item:${it.id}:${payload.event}`)
  } catch (e) {
    if (isClosedError(e)) return // nobody to tell; the portal shows the status
    mapTicketsError(e)
  }
}

// ------------------------------------------------------- batch summary --

export async function summarySweep(ctx: P3Ctx): Promise<number> {
  const rows = (await ctx.db.execute<{ id: number }>(sql`
    SELECT b.id FROM batches b
    WHERE b.status = 'submitted' AND b.ticket_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM items i WHERE i.batch_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM items i WHERE i.batch_id = b.id AND i.status IN ('probing', 'draft', 'pending'))
    ORDER BY b.id LIMIT 50`)) as unknown as { id: number }[]
  for (const r of rows) await enqueue(ctx.db, 'batch_summary', { batchId: r.id }, { dedupeKey: `batch_summary:batch:${r.id}` })
  return rows.length
}

function decisionLine(it: Item): string {
  const name = `#${it.id} ${itemName(it)}`
  switch (it.status) {
    case 'denied':
      return `${name}: denied. Reason: ${(it.denyReason ?? '').replace(/\s+/g, ' ').slice(0, 300)}`
    case 'withdrawn':
      return `${name}: withdrawn`
    case 'rejected':
      return `${name}: not accepted (the file check failed)`
    case 'failed':
      return `${name}: approved, but could not be added`
    default:
      return `${name}: approved`
  }
}

export function summaryBody(batchId: number, its: readonly Item[]): string {
  const head = `Review complete for batch #${batchId}.`
  const lines: string[] = []
  let used = head.length
  for (const [i, it] of its.entries()) {
    const l = decisionLine(it)
    if (used + l.length + 1 > 1700) {
      lines.push(`…and ${its.length - i} more (see the portal).`)
      break
    }
    lines.push(l)
    used += l.length + 1
  }
  return [head, ...lines].join('\n')
}

export async function batchSummary(ctx: P3Ctx, payload: { batchId: number }) {
  const b = await ctx.db.query.batches.findFirst({ where: eq(batches.id, payload.batchId) })
  if (!b) throw new Permanent('batch missing')
  if (b.status !== 'submitted') return
  if (!b.ticketId) throw new RetryLater(60, 'ticket not open yet')
  const its = await ctx.db.query.items.findMany({ where: eq(items.batchId, b.id), orderBy: asc(items.id) })
  if (its.some((i) => (UNDECIDED as readonly string[]).includes(i.status))) return
  // The per-item decision posts go first.
  const ids = its.map((i) => i.id)
  if (ids.length === 0) return
  const [{ n } = { n: 0 }] = (await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM jobs
    WHERE kind = 'ticket_decision' AND status IN ('queued', 'running')
      AND (payload->>'itemId')::int IN ${sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`}`)) as unknown as { n: number }[]
  if (n > 0) throw new Defer(30, 'decision posts pending')

  let closed = false
  try {
    await ctx.tickets.postMessage(b.ticketId, { kind: 'system', body: summaryBody(b.id, its) }, `summary:batch:${b.id}`)
    await ctx.tickets.patchTicket(b.ticketId, { status: 'completed' })
  } catch (e) {
    if (!isClosedError(e)) mapTicketsError(e)
    closed = true
  }
  const now = new Date(ctx.now())
  await ctx.db
    .update(batches)
    .set({ status: closed ? 'closed' : 'completed', ticketStatus: closed ? 'closed' : 'completed', updatedAt: now })
    .where(and(eq(batches.id, b.id), eq(batches.status, 'submitted')))
  await audit(ctx.db, { action: closed ? 'batch.closed' : 'batch.completed', targetType: 'batch', targetId: b.id, detail: { ticketId: b.ticketId } })
}

// ---------------------------------------------------------- auto-close --

async function autoCloseDays(ctx: P3Ctx): Promise<number> {
  const v = Number(await getSetting(ctx.db, 'auto_close_days'))
  return Number.isFinite(v) && v >= 1 ? v : 7
}

// Last activity = the batch's own updates (completion, ticket status
// webhooks) or any comment on it (portal or ticket reply).
const LAST_ACTIVITY = sql`greatest(b.updated_at, coalesce((SELECT max(c.created_at) FROM comments c WHERE c.batch_id = b.id), b.updated_at))`

export async function autoCloseSweep(ctx: P3Ctx): Promise<number> {
  const days = await autoCloseDays(ctx)
  const cutoff = new Date(ctx.now() - days * 86_400_000)
  const rows = (await ctx.db.execute<{ id: number; last: Date | string }>(sql`
    SELECT b.id, ${LAST_ACTIVITY} AS last FROM batches b
    WHERE b.status = 'completed' AND b.ticket_id IS NOT NULL AND coalesce(b.ticket_status, '') <> 'closed'
      AND ${LAST_ACTIVITY} < ${cutoff}
    ORDER BY b.id LIMIT 50`)) as unknown as { id: number; last: Date | string }[]
  for (const r of rows) {
    const last = new Date(r.last).getTime()
    await enqueue(ctx.db, 'ticket_autoclose', { batchId: r.id }, { dedupeKey: `ticket_autoclose:batch:${r.id}:${last}` })
  }
  return rows.length
}

export async function ticketAutoclose(ctx: P3Ctx, payload: { batchId: number }) {
  const days = await autoCloseDays(ctx)
  const cutoff = new Date(ctx.now() - days * 86_400_000)
  const [row] = (await ctx.db.execute<{ id: number; ticket_id: number }>(sql`
    SELECT b.id, b.ticket_id FROM batches b
    WHERE b.id = ${payload.batchId} AND b.status = 'completed' AND b.ticket_id IS NOT NULL
      AND coalesce(b.ticket_status, '') <> 'closed' AND ${LAST_ACTIVITY} < ${cutoff}`)) as unknown as { id: number; ticket_id: number }[]
  if (!row) return // activity since the sweep, or already closed
  try {
    await ctx.tickets.closeTicket(row.ticket_id, { reason: `Closed automatically after ${days} days without activity.` })
  } catch (e) {
    mapTicketsError(e)
  }
  const now = new Date(ctx.now())
  await ctx.db
    .update(batches)
    .set({ status: 'closed', ticketStatus: 'closed', updatedAt: now })
    .where(and(eq(batches.id, row.id), inArray(batches.status, ['completed'])))
  await audit(ctx.db, { action: 'batch.auto_closed', targetType: 'batch', targetId: row.id, detail: { ticketId: row.ticket_id, days } })
}
