// Periodic sweeps (contract PERIODIC_EVENT_JOB_KINDS): the loop runs them on
// timers (loop.ts), and they also run when a job of that kind is claimed.
//
//   stinger_sync      EFM Stingers/ → event_stingers (every 6 h)
//   pending_expire    a pending request expires 12 h before its start
//   pending_reminder  one staff reminder in the ticket, when the request has
//                     waited 3 days or starts within 3 days, whichever first
//   audio_expire      custom audio never attached to a submitted event is
//                     deleted after events_audio_unused_days (14)

import { STINGER_FILE_RE } from '../../azuracast/allowlist'
import { PENDING_EXPIRE_BEFORE_START_H, PENDING_REMINDER_AFTER_D } from '../../contract/rules'
import type { EventsCtx } from '../ctx'
import type { StingerRow } from '../store'
import { cardText, postToTicket, whenLine } from './tickets'

const H = 3600_000
const D = 24 * H

export async function stingerSync(ctx: EventsCtx): Promise<number> {
  const entries = await ctx.az.listStingers()
  const rows: StingerRow[] = []
  for (const e of entries) {
    const m = e.media
    if (e.type !== 'file' || !m || m.path !== e.path || !STINGER_FILE_RE.test(e.path)) continue
    const lengthS = Math.round(typeof m.length === 'number' ? m.length : 0)
    if (lengthS < 1) continue
    const base = e.path.slice(e.path.lastIndexOf('/') + 1).replace(/\.[a-z0-9]{1,5}$/i, '')
    rows.push({ mediaId: m.id, path: e.path, title: cardText(m.title || base, 200) || base, lengthS })
  }
  await ctx.store.replaceStingers(rows)
  return rows.length
}

export async function pendingExpire(ctx: EventsCtx): Promise<number> {
  let n = 0
  const now = ctx.now()
  for (const ev of await ctx.store.eventsByStatus('pending', 500)) {
    if (ev.startsAt.getTime() - PENDING_EXPIRE_BEFORE_START_H * H > now) continue
    if (!(await ctx.store.setEventStatus(ev.id, ['pending'], 'expired'))) continue
    n++
    await ctx.store.audit('events.expired', 'event', ev.id, {})
    await postToTicket(ctx, ev.id, 'expired', `This request expired: no decision was made by 12 hours before the start (${whenLine(ev)}).`, `expired:${ev.id}`)
    await ctx.store.enqueue('ticket_close', { eventId: ev.id, reason: 'Request expired before a decision' })
    // An edited, previously built event may still have playlists.
    await ctx.store.enqueue('teardown', { eventId: ev.id }, { dedupeExtra: 'expired' })
  }
  return n
}

export async function pendingReminder(ctx: EventsCtx): Promise<number> {
  let n = 0
  const now = ctx.now()
  for (const ev of await ctx.store.eventsByStatus('pending', 500)) {
    const start = ev.startsAt.getTime()
    if (start - PENDING_EXPIRE_BEFORE_START_H * H <= now) continue
    const waited = ev.submittedAt !== null && now - ev.submittedAt.getTime() >= PENDING_REMINDER_AFTER_D * D
    const soon = start - now <= PENDING_REMINDER_AFTER_D * D
    if (!waited && !soon) continue
    if (!ev.ticketId && !(await ctx.store.hasEventJob('ticket_open', ev.id))) continue
    // One per request: the idem key is also the job's permanent dedupe key.
    await postToTicket(ctx, ev.id, 'reminder', `Reminder for staff: this request is still waiting for a decision. It expires 12 hours before the start (${whenLine(ev)}).`, `reminder:${ev.id}`)
    n++
  }
  return n
}

export async function audioExpire(ctx: EventsCtx): Promise<number> {
  const s = await ctx.store.settings()
  const now = ctx.now()
  let n = 0
  for (const a of await ctx.store.unusedAudio(new Date(now - s.events_audio_unused_days * D), 200)) {
    if (!(await ctx.store.markAudioDeletedIfUnused(a.id, new Date(now), 'expired_unused'))) continue
    n++
    await ctx.store.audit('events.audio.expired', 'event_audio', a.id, {})
    if (a.mediaId !== null) await ctx.store.enqueue('audio_delete', { audioId: a.id })
  }
  return n
}
