'use client'

// Public event page: GET /api/ev/events/:id, rendered per projection.

import { useJson } from '@/components/hooks'
import type { EventView } from '@/events/contract/types'
import { project, StatusChip } from './EventViewCard'
import { When } from './tz'

export function EventDetail({ id, viewer }: { id: number; viewer: { discordId: string; review: boolean } | null }) {
  const { data, error, loading } = useJson<EventView>(`/api/ev/events/${id}`)
  if (error) return <p className="notice notice-error">This event doesn&apos;t exist, or it isn&apos;t on the public calendar.</p>
  if (loading || !data) return <p className="text-sm text-cream/60">Loading…</p>
  const p = project(data)
  const own = data.kind === 'full' && viewer && data.ownerDiscordId === viewer.discordId
  return (
    <article className="card space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ev-dot" data-kind={p.kind} aria-hidden="true" />
        {p.status === 'live' || p.kind === 'full' ? <StatusChip status={p.status} /> : null}
        {p.details ? <span className="ev-tag">{p.details.typeLabel}</span> : null}
      </div>
      <h1 className={`text-2xl font-bold ${p.details ? 'text-cream' : 'text-cream/80'}`}>{p.heading}</h1>
      <dl className="facts">
        <dt>When</dt>
        <dd>
          <When at={p.startsAt} end={p.endsAt} />
        </dd>
        {p.details?.hostName ? (
          <>
            <dt>Host</dt>
            <dd>{p.details.hostName}</dd>
          </>
        ) : null}
        {p.details?.location ? (
          <>
            <dt>Where</dt>
            <dd>{p.details.location}</dd>
          </>
        ) : null}
      </dl>
      {p.details?.description ? <p className="whitespace-pre-line text-cream/85">{p.details.description}</p> : null}
      {p.kind === 'private' ? <p className="text-sm text-cream/65">This is a private booking, so only its time is shown.</p> : null}
      {p.kind === 'pending' ? <p className="text-sm text-cream/65">This time is held by a request that is waiting for review.</p> : null}
      <div className="flex flex-wrap gap-3">
        <a className="btn btn-primary" href="/listen">
          {p.status === 'live' ? 'Listen live' : 'Open the player'}
        </a>
        {own ? (
          <a className="btn btn-secondary" href={`/my/events/${p.id}`}>
            Manage this event
          </a>
        ) : null}
        {viewer?.review ? (
          <a className="btn btn-secondary" href={`/staff/events/${p.id}`}>
            Staff view
          </a>
        ) : null}
        <a className="btn btn-secondary" href="/calendar">
          Back to the calendar
        </a>
      </div>
    </article>
  )
}
