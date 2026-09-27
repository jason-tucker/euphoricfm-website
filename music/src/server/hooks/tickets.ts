// POST /api/hooks/tickets — signed deliveries from tickets-web over the
// efm-music-hooks network. The public edge 404s /api/hooks/*; as a second
// fence, anything that carries Cloudflare headers is answered 404 here too.
//
// Order: size cap → signature (raw bytes, before parsing) → delivery-id dedupe
// (in the same transaction as the effect) → parse → apply, anchored ONLY to
// the batch/request bound to that ticket id. Unknown tickets are ignored.

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
    source: z.string(),
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

  return deps.db.transaction(async (tx) => {
    const fresh = await tx
      .insert(hookDeliveries)
      .values({ deliveryId: deliveryId!, event: payload.event, ticketId: payload.ticketId })
      .onConflictDoNothing()
      .returning({ id: hookDeliveries.deliveryId })
    if (fresh.length === 0) return { status: 200, body: { ok: true, duplicate: true } }

    const batch = await tx.query.batches.findFirst({ where: eq(batches.ticketId, payload.ticketId) })
    const request = batch ? undefined : await tx.query.requests.findFirst({ where: eq(requests.ticketId, payload.ticketId) })
    const expectedRef = batch ? `batch:${batch.id}` : request ? `request:${request.id}` : null
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
        deliveryId: deliveryId!,
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
