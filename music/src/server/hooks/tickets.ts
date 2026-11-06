// POST /api/hooks/tickets — signed deliveries from tickets-web over the
// efm-music-hooks network. The public edge 404s /api/hooks/*; as a second
// fence, anything that carries Cloudflare headers is answered 404 here too.
//
// Order: size cap → signature (raw bytes, before parsing) → delivery-id dedupe
// (in the same transaction as the effect) → parse → apply, anchored ONLY to
// the batch/request bound to that ticket id. Unknown tickets are ignored,
// except one whose externalRef names a submitted batch (or a request) that is
// still waiting for its ticket id: that answers 409 WITHOUT recording the
// delivery, so tickets-web retries it.

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DB } from '../db/client'
import { batches, comments, hookDeliveries, items, requests } from '../db/schema'
import { readBodyLimited } from '../http/body'
import { HttpError } from '../http/errors'
import { HOOK_BODY_LIMIT } from '../http/limits'
import { verifyTicketsSignature } from './signature'

const author = z.object({ discordId: z.string().nullable().optional(), name: z.string().nullable().optional() }).nullable().optional()

const messageEvent = z.object({
  event: z.literal('message.created'),
  ticketId: z.number().int().positive(),
  externalRef: z.string().max(100).nullable().optional(),
  occurredAt: z.string().optional(),
  message: z.object({
    id: z.string(),
    // INTEGRATION_API: only these sources are ever delivered; anything else
    // (e.g. an internal staff note) is acknowledged and ignored, never stored
    // as a member-visible comment.
    source: z.enum(['discord', 'web', 'system']),
    body: z.string(),
    createdAt: z.string().optional(),
    author,
  }),
})

const ticketEvent = z.object({
  event: z.enum(['ticket.status_changed', 'ticket.closed', 'ticket.claimed', 'ticket.unclaimed']),
  ticketId: z.number().int().positive(),
  externalRef: z.string().max(100).nullable().optional(),
  occurredAt: z.string().optional(),
  ticket: z.object({ status: z.string().max(32) }).passthrough().optional(),
})

const payloadSchema = z.union([messageEvent, ticketEvent])

export const ITEM_ANCHOR_RE = /^\s*\[item:(\d{1,9})\]\s*/

export type HookDeps = { db: DB; secrets: readonly string[]; nowSec?: () => number }

export async function handleTicketsHook(req: Request, deps: HookDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.headers.get('cf-ray') || req.headers.get('cf-connecting-ip')) return { status: 404, body: { error: 'not_found' } }
  let raw: Buffer
  try {
    raw = await readBodyLimited(req, HOOK_BODY_LIMIT)
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.code } }
    throw e
  }
  const deliveryId = req.headers.get('x-euphoric-delivery')
  const verdict = verifyTicketsSignature({
    secrets: deps.secrets,
    header: req.headers.get('x-euphoric-signature'),
    deliveryId,
    rawBody: raw,
    nowSec: deps.nowSec?.() ?? Math.floor(Date.now() / 1000),
  })
  if (!verdict.ok) return { status: 401, body: { error: `signature_${verdict.reason}` } }

  let payload: z.infer<typeof payloadSchema>
  try {
    payload = payloadSchema.parse(JSON.parse(raw.toString('utf8')))
  } catch {
    // Authentic but not understood (e.g. a future event): acknowledge so the
    // sender does not retry forever; nothing is applied.
    return { status: 200, body: { ok: true, ignored: 'unrecognised' } }
  }

  try {
    return await applyDelivery(deps, deliveryId!, payload)
  } catch (e) {
    if (e instanceof RetryDelivery) return { status: 409, body: { error: 'ticket_not_bound_yet' } }
    throw e
  }
}

class RetryDelivery extends Error {}

// A batch/request named by externalRef that has no ticket id yet, but is in
// a state where the worker is opening its ticket.
async function awaitingBinding(tx: Pick<DB, 'query'>, ref: string | null | undefined): Promise<boolean> {
  const m = /^(batch|request):(\d{1,9})$/.exec(ref ?? '')
  if (!m) return false
  const id = Number(m[2])
  if (m[1] === 'batch') {
    const b = await tx.query.batches.findFirst({ where: eq(batches.id, id) })
    return !!b && b.ticketId === null && b.status === 'submitted'
  }
  const r = await tx.query.requests.findFirst({ where: eq(requests.id, id) })
  return !!r && r.ticketId === null
}

async function applyDelivery(deps: HookDeps, deliveryId: string, payload: z.infer<typeof payloadSchema>): Promise<{ status: number; body: Record<string, unknown> }> {
  return deps.db.transaction(async (tx) => {
    const fresh = await tx
      .insert(hookDeliveries)
      .values({ deliveryId, event: payload.event, ticketId: payload.ticketId })
      .onConflictDoNothing()
      .returning({ id: hookDeliveries.deliveryId })
    if (fresh.length === 0) return { status: 200, body: { ok: true, duplicate: true } }

    const batch = await tx.query.batches.findFirst({ where: eq(batches.ticketId, payload.ticketId) })
    const request = batch ? undefined : await tx.query.requests.findFirst({ where: eq(requests.ticketId, payload.ticketId) })
    const expectedRef = batch ? `batch:${batch.id}` : request ? `request:${request.id}` : null
    if (!expectedRef && (await awaitingBinding(tx, payload.externalRef))) {
      // The worker has opened this ticket but not stored its id yet. Do not
      // record the delivery (the transaction rolls back); ask for a retry.
      throw new RetryDelivery()
    }
    if (!expectedRef || (payload.externalRef && payload.externalRef !== expectedRef)) {
      return { status: 200, body: { ok: true, ignored: 'unknown_ticket' } }
    }

    if (payload.event === 'message.created') {
      let body = payload.message.body
      let itemId: number | null = null
      const m = ITEM_ANCHOR_RE.exec(body)
      if (m && batch) {
        // Anchor to an item only if it belongs to THIS ticket's batch.
        const it = await tx.query.items.findFirst({ where: and(eq(items.id, Number(m[1])), eq(items.batchId, batch.id)) })
        if (it) {
          itemId = it.id
          body = body.slice(m[0].length)
        }
      }
      await tx.insert(comments).values({
        batchId: batch?.id ?? null,
        requestId: request?.id ?? null,
        itemId,
        source: 'ticket',
        visibility: 'all',
        body: body.slice(0, 4000),
        authorDiscordId: payload.message.author?.discordId ?? null,
        authorName: payload.message.author?.name?.slice(0, 100) ?? null,
        deliveryId,
      })
      return { status: 200, body: { ok: true } }
    }

    const status = payload.ticket?.status ?? (payload.event === 'ticket.closed' ? 'closed' : undefined)
    if (status) {
      if (batch) await tx.update(batches).set({ ticketStatus: status, updatedAt: new Date() }).where(eq(batches.id, batch.id))
      if (request) await tx.update(requests).set({ ticketStatus: status, updatedAt: new Date() }).where(eq(requests.id, request.id))
    }
    return { status: 200, body: { ok: true } }
  })
}
