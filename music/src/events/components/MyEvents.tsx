'use client'

// My events: the signed-in member's events (GET /api/ev/my/events), grouped
// into drafts, upcoming and past, each row opening its edit page.

import { useJson } from '@/components/hooks'
import { Notice } from '@/components/ui'
import { StatusChip } from './EventViewCard'
import { useNow } from './hooks'
import { listOf, type FullView } from './types'
import { When } from './tz'

const PAST = new Set(['ended', 'denied', 'withdrawn', 'cancelled', 'expired', 'failed'])

export function groupMine(list: FullView[], now: number) {
  const sorted = [...list].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  return {
    drafts: sorted.filter((v) => v.status === 'draft' && Date.parse(v.endsAt) > now),
    upcoming: sorted.filter((v) => v.status !== 'draft' && !PAST.has(v.status) && Date.parse(v.endsAt) > now),
    past: sorted.filter((v) => PAST.has(v.status) || Date.parse(v.endsAt) <= now).reverse(),
  }
}

function Row({ v }: { v: FullView }) {
  return (
    <a href={`/my/events/${v.id}`} className="row-link">
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-semibold text-cream">{v.title}</span>
          <StatusChip status={v.status} />
          {v.visibility === 'private' ? <span className="ev-tag">Private</span> : null}
        </span>
        <span className="block text-sm text-cream/75">
          <When at={v.startsAt} end={v.endsAt} />
        </span>
      </span>
    </a>
  )
}

function Group({ title, list, empty }: { title: string; list: FullView[]; empty?: string }) {
  if (!list.length && !empty) return null
  return (
    <section className="space-y-2" aria-label={title}>
      <h2 className="text-lg font-bold text-cream">
        {title} ({list.length})
      </h2>
      {list.length ? (
        <ul className="space-y-2">
          {list.map((v) => (
            <li key={v.id}>
              <Row v={v} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-cream/60">{empty}</p>
      )}
    </section>
  )
}

export function MyEvents() {
  const now = useNow(60_000)
  const { data, error, loading } = useJson<unknown>('/api/ev/my/events')
  if (error) return <Notice tone="error">Couldn&apos;t load your events. Try again in a minute.</Notice>
  if (loading || !data) return <p className="text-sm text-cream/60">Loading…</p>
  const g = groupMine(listOf<FullView>(data), now)
  return (
    <div className="space-y-8">
      <Group title="Drafts" list={g.drafts} />
      <Group title="Upcoming" list={g.upcoming} empty="Nothing coming up. Request an event to get started." />
      <Group title="Past" list={g.past} />
    </div>
  )
}
