// Outbound tickets (plan §2 "Tickets"): the efm-events integration key
// (EVENTS_TICKETS_WRITE_KEY; scopes tickets:write + tickets:close; category
// 'eventrequest' only; no actor impersonation). Every post carries an
// Idempotency-Key, so a retried job never double-posts.

import { createHash } from 'node:crypto'
import { IDEMPOTENCY_KEY_RE, TicketsApiError } from '../../../server/tickets/client'
import type { EventJobPayload, TicketPostKind } from '../../contract/jobs'
import { TICKET_CATEGORY_KEY, ticketExternalRef } from '../../contract/rules'
import type { EventsCtx } from '../ctx'
import { Permanent, Wait } from '../errors'
import type { EventRow } from '../store'

const TRANSIENT_MAX_AGE_S = 24 * 3600
const TICKET_WAIT_MAX_AGE_S = 7 * 24 * 3600

function fromTickets(e: unknown): never {
  if (e instanceof TicketsApiError) {
    if (e.retryable) throw new Wait(e.retryAfterS ?? 30, `${e.status} ${e.code}`, { maxAgeS: TRANSIENT_MAX_AGE_S })
    throw new Permanent(`${e.status} ${e.code}`)
  }
  throw e
}

// Plain one-line text for a card line: no control/format characters,
// collapsed whitespace, bounded.
export function cardText(s: string, max: number): string {
  return s
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

const whenFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })

export function whenLine(ev: Pick<EventRow, 'startsAt' | 'endsAt'>): string {
  const sameDay = ev.endsAt.getTime() - ev.startsAt.getTime() < 24 * 3600_000
  return `${whenFmt.format(ev.startsAt)} – ${sameDay ? timeFmt.format(ev.endsAt) : whenFmt.format(ev.endsAt)} ET`
}

export function eventLink(ctx: EventsCtx, eventId: number): string {
  return `${ctx.origin}/my/events/${eventId}`
}

export async function ticketOpen(ctx: EventsCtx, p: EventJobPayload<'ticket_open'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  if (ev.ticketId) return
  if (ev.status === 'draft') return
  const tracks = await ctx.store.tracks(ev.id)
  const anns = await ctx.store.announcements(ev.id)
  const pinned = tracks.filter((t) => t.pinAt !== null).length
  const lines = [
    `When: ${whenLine(ev)}`,
    `Visibility: ${ev.visibility === 'private' ? 'Private' : 'Public'}`,
    `Type: ${ev.eventType.replace(/_/g, ' ')}`,
    `Songs: ${tracks.length}${pinned ? ` (${pinned} pinned)` : ''}`,
    `Announcements: ${anns.length}`,
    ...(ev.shortNotice ? ['Short notice (under 48 h)'] : []),
    ...(ev.createdByStaff ? ['Booked by staff'] : []),
  ].map((l) => cardText(l, 200))
  let res
  try {
    res = await ctx.tickets.openTicket({
      categoryKey: TICKET_CATEGORY_KEY,
      openerDiscordId: ev.ownerDiscordId,
      subject: `Event request #${ev.id}`,
      card: { title: cardText(ev.title, 100) || `Event #${ev.id}`, lines, link: { label: 'Open event', url: eventLink(ctx, ev.id) } },
      externalRef: ticketExternalRef(ev.id),
    })
  } catch (e) {
    fromTickets(e)
  }
  await ctx.store.setTicket(ev.id, { ticketId: res.ticketId, ticketNumber: res.number, ticketUrl: res.webUrl })
  await ctx.store.audit('events.ticket.opened', 'event', ev.id, { ticketId: res.ticketId, created: res.created })
  await ctx.store.wakeEventJobs(ev.id, ['ticket_post', 'ticket_close'])
}

// A ticket to post to, a wait while one is being opened, or null when this
// event has none and never will (a staff booking without a ticket).
async function ticketOf(ctx: EventsCtx, ev: EventRow): Promise<number | null> {
  if (ev.ticketId) return ev.ticketId
  if (await ctx.store.hasEventJob('ticket_open', ev.id)) throw new Wait(60, 'ticket not open yet', { maxAgeS: TICKET_WAIT_MAX_AGE_S })
  return null
}

export function idemKey(idem: string): string {
  const k = `evt:${idem}`
  if (IDEMPOTENCY_KEY_RE.test(k)) return k
  return `evt:h:${createHash('sha256').update(idem).digest('hex').slice(0, 48)}`
}

export async function ticketPost(ctx: EventsCtx, p: EventJobPayload<'ticket_post'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  const ticketId = await ticketOf(ctx, ev)
  if (ticketId === null) return
  const body = p.body.length > 1800 ? `${p.body.slice(0, 1799)}…` : p.body
  try {
    await ctx.tickets.postMessage(ticketId, { kind: 'system', body, itemRef: `event:${ev.id}:${p.kind}` }, idemKey(p.idem))
  } catch (e) {
    fromTickets(e)
  }
}

export async function ticketClose(ctx: EventsCtx, p: EventJobPayload<'ticket_close'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  const ticketId = await ticketOf(ctx, ev)
  if (ticketId === null) return
  try {
    await ctx.tickets.closeTicket(ticketId, { reason: cardText(p.reason, 500) })
  } catch (e) {
    fromTickets(e)
  }
}

// The worker's own posts (built / on air / ended / failed / recheck).
export async function postToTicket(ctx: EventsCtx, eventId: number, kind: TicketPostKind, body: string, idem: string): Promise<void> {
  await ctx.store.enqueue('ticket_post', { eventId, kind, body: body.slice(0, 4000), idem })
}
