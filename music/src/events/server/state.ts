// The events state machine (plan §3; contract EventStatus). Pure: which
// actor may move an event from which status to which, and which jobs each
// move enqueues. service.ts applies it with a conditional UPDATE (WHERE
// status = <from> AND version = <v>) so two racing actors cannot both win.
//
//   draft ──submit──▶ pending ──approve──▶ approved ──(worker build)──▶ built ──▶ live ──▶ ended
//     │                 │ ▲                  │                          │
//     │                 │ └── member edit ───┴── (re-approval) ─────────┘
//     │                 ├──deny──▶ denied
//     └──withdraw──▶ withdrawn ◀──withdraw── pending|approved|built
//                   cancelled ◀──cancel (staff)── pending|approved|built|live
//   worker only: pending → expired, approved|built → built/failed, built → live → ended

import { forbidden, HttpError } from '../../server/http/errors'
import type { EventJobKind, EventJobPayload } from '../contract/jobs'
import type { EventStatus } from '../contract/types'
import type { Actor } from './rules'
import { approvedBody, cancelledBody, deniedBody, withdrawnBody } from './tickets-outbound'

export type Action = 'submit' | 'withdraw' | 'approve' | 'deny' | 'cancel'

type Rule = { from: readonly EventStatus[]; to: EventStatus; who: 'owner' | 'staff' }

export const TRANSITIONS: Record<Action, Rule> = {
  submit: { from: ['draft'], to: 'pending', who: 'owner' },
  withdraw: { from: ['draft', 'pending', 'approved', 'built'], to: 'withdrawn', who: 'owner' },
  approve: { from: ['pending'], to: 'approved', who: 'staff' },
  deny: { from: ['pending'], to: 'denied', who: 'staff' },
  cancel: { from: ['pending', 'approved', 'built', 'live'], to: 'cancelled', who: 'staff' },
}

/** The status `action` moves `ev` to, or the refusal (403 forbidden / 409 not_editable). */
export function nextStatus(action: Action, ev: { ownerUserId: string; status: EventStatus }, actor: Actor): EventStatus {
  const r = TRANSITIONS[action]
  if (r.who === 'owner' && ev.ownerUserId !== actor.userId) throw forbidden()
  if (r.who === 'staff' && !actor.staff) throw forbidden()
  if (!r.from.includes(ev.status)) throw new HttpError(409, 'not_editable', { status: ev.status })
  return r.to
}

export type PlannedJob = {
  [K in EventJobKind]: { kind: K; payload: EventJobPayload<K>; dedupeExtra?: string | number; runAfter?: Date }
}[EventJobKind]

export type TransitionCtx = {
  /** events_autobuild_enabled */
  autobuild: boolean
  /** the ticket exists or was requested (ticket_open enqueued) */
  hasTicket: boolean
  /** the event may have AzuraCast playlists (was approved at some point) */
  mayBeBuilt: boolean
  reason?: string
}

const post = (eventId: number, kind: EventJobPayload<'ticket_post'>['kind'], body: string, idem: string): PlannedJob => ({
  kind: 'ticket_post',
  payload: { eventId, kind, body, idem },
})

/** Jobs a transition enqueues (after the status change commits in the same transaction). */
export function jobsFor(action: Action, ev: { id: number; version: number }, ctx: TransitionCtx): PlannedJob[] {
  const id = ev.id
  const v = ev.version
  const out: PlannedJob[] = []
  const close = (reason: string): PlannedJob => ({ kind: 'ticket_close', payload: { eventId: id, reason } })
  const teardown: PlannedJob = { kind: 'teardown', payload: { eventId: id }, dedupeExtra: `v${v}:${action}` }
  switch (action) {
    case 'submit':
      out.push({ kind: 'ticket_open', payload: { eventId: id } })
      break
    case 'approve':
      if (ctx.hasTicket) out.push(post(id, 'approved', approvedBody(ctx.autobuild), `approved:${id}:${v}`))
      if (ctx.autobuild) out.push({ kind: 'build', payload: { eventId: id, version: v } })
      break
    case 'deny':
      if (ctx.hasTicket) out.push(post(id, 'denied', deniedBody(ctx.reason ?? ''), `denied:${id}:${v}`), close('denied'))
      if (ctx.mayBeBuilt) out.push(teardown)
      break
    case 'withdraw':
      if (ctx.hasTicket) out.push(post(id, 'withdrawn', withdrawnBody(), `withdrawn:${id}:${v}`), close('withdrawn'))
      if (ctx.mayBeBuilt) out.push(teardown)
      break
    case 'cancel':
      if (ctx.hasTicket) out.push(post(id, 'cancelled', cancelledBody(ctx.reason ?? ''), `cancelled:${id}:${v}`), close('cancelled'))
      if (ctx.mayBeBuilt) out.push(teardown)
      break
  }
  return out
}

/** Statuses that may have AzuraCast playlists behind them. */
export const MAY_BE_BUILT: readonly EventStatus[] = ['approved', 'built', 'live']
