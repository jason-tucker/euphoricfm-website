'use client'

// Renders one EventView projection. Each kind reads ONLY the fields that kind
// may carry, so a private or pending slot never shows a title, host, place or
// description even if one arrived by mistake.

import { Chip } from '@/components/ui'
import type { EventView } from '@/events/contract/types'
import { EVENT_TYPE_LABEL, statusOf } from './labels'
import { When } from './tz'

export type Projected = { kind: EventView['kind']; id: number; startsAt: string; endsAt: string; heading: string; status: string; details: null | { hostName: string | null; location: string | null; description: string | null; typeLabel: string } }

/** The safe, display-ready subset of a view. */
export function project(v: EventView): Projected {
  const base = { kind: v.kind, id: v.id, startsAt: v.startsAt, endsAt: v.endsAt, status: v.status }
  switch (v.kind) {
    case 'public':
      return { ...base, heading: v.title, details: { hostName: v.hostName, location: v.location, description: v.description, typeLabel: EVENT_TYPE_LABEL[v.eventType] ?? 'Event' } }
    case 'full':
      return { ...base, heading: v.title, details: { hostName: v.hostName, location: v.location, description: v.description, typeLabel: EVENT_TYPE_LABEL[v.eventType] ?? 'Event' } }
    case 'private':
      return { ...base, heading: 'Booked · Private event', details: null }
    case 'pending':
      return { ...base, heading: 'Pending', details: null }
  }
}

export function StatusChip({ status }: { status: string }) {
  const s = statusOf(status)
  return (
    <Chip tone={s.tone} title={s.help}>
      <span data-status={status}>{s.label}</span>
    </Chip>
  )
}

/** A calendar/agenda row. Public (and own/staff) events link to their page. */
export function EventViewCard({ view, href, showDescription = false }: { view: EventView; href?: string | null; showDescription?: boolean }) {
  const p = project(view)
  const link = href === undefined ? (p.kind === 'public' || p.kind === 'full' ? `/events/${p.id}` : null) : href
  const body = (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ev-dot" data-kind={p.kind} aria-hidden="true" />
        <span className={`font-semibold ${p.details ? 'text-cream' : 'text-cream/75'}`} data-testid="ev-heading">
          {p.heading}
        </span>
        {p.status === 'live' ? <StatusChip status="live" /> : p.kind === 'full' ? <StatusChip status={p.status} /> : null}
      </div>
      <p className="text-sm text-cream/80">
        <When at={p.startsAt} end={p.endsAt} />
      </p>
      {p.details ? (
        <p className="text-xs text-cream/60">
          {[p.details.typeLabel, p.details.hostName ? `Hosted by ${p.details.hostName}` : null, p.details.location].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {showDescription && p.details?.description ? <p className="line-clamp-3 whitespace-pre-line text-sm text-cream/75">{p.details.description}</p> : null}
    </div>
  )
  return link ? (
    <a href={link} className="row-link" data-kind={p.kind}>
      {body}
    </a>
  ) : (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-cream/15 px-3 py-3" data-kind={p.kind}>
      {body}
    </div>
  )
}
