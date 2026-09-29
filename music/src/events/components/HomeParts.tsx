'use client'

// Client parts of the events home page: the member rules (numbers from
// GET /api/ev/config), the next public events and the Listen card.

import { useEffect, useState } from 'react'
import { useJson } from '@/components/hooks'
import type { EventView } from '@/events/contract/types'
import { EventViewCard } from './EventViewCard'
import { useEvConfig } from './hooks'
import { songLine, useNowPlaying } from './nowplaying'
import { DAY } from './time'
import { listOf, type EvConfig } from './types'

export function rulesList(c: EvConfig): string[] {
  return [
    `Request at least ${c.minNoticeH} hours before your event starts. Under ${c.warnNoticeH} hours we'll still take it, but we may not be able to get it ready in time.`,
    `Events can be up to ${c.memberMaxHours} hours long and up to ${c.horizonDays} days ahead.`,
    `You can have up to ${c.maxPending} requests waiting for review and ${c.maxUpcoming} upcoming approved events at a time.`,
    `Events can't overlap, and there are at least ${c.gapMin} minutes between two events.`,
    `Changes lock ${c.freezeMin} minutes before your event starts. After that, ask in your ticket.`,
    `Songs are never cut off: a pinned song waits for the song before it to end. The last song may run up to ${c.endWaitS} seconds past the end of your event.`,
    'Announcements cut in at their time, then the music carries on.',
    'Changing an approved event (title, songs, announcements, time or visibility) sends it back for a quick re-approval. Your slot stays held.',
  ]
}

export function MemberRules({ heading = 'The rules, in plain words' }: { heading?: string }) {
  const { config } = useEvConfig()
  return (
    <section aria-labelledby="ev-rules-h" className="card space-y-3">
      <h2 id="ev-rules-h" className="text-lg font-bold text-cream">
        {heading}
      </h2>
      <ul className="list-disc space-y-2 pl-5 text-sm text-cream/85" data-testid="ev-rules">
        {rulesList(config).map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {!config.eventsEnabled ? (
        <p className="notice notice-warn">Requests from members open soon. You can already look around, sign in and see the calendar.</p>
      ) : null}
    </section>
  )
}

export function UpcomingPublic({ limit = 4 }: { limit?: number }) {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  useEffect(() => {
    const now = Date.now()
    setRange({ from: new Date(now - DAY).toISOString(), to: new Date(now + 120 * DAY).toISOString() })
  }, [])
  const { data, error, loading } = useJson<unknown>(range ? `/api/ev/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : null)
  const nowMs = Date.now()
  const list = listOf<EventView>(data)
    .filter((v) => v.kind === 'public' && Date.parse(v.endsAt) > nowMs)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, limit)
  return (
    <section aria-labelledby="ev-up-h" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="ev-up-h" className="text-lg font-bold text-cream">
          Coming up
        </h2>
        <a className="btn btn-secondary btn-sm" href="/calendar">
          Full calendar
        </a>
      </div>
      {error ? (
        <p className="notice notice-error">Couldn&apos;t load the calendar. Try again in a minute.</p>
      ) : loading || !range ? (
        <p className="text-sm text-cream/60">Loading events…</p>
      ) : list.length ? (
        <ul className="space-y-2">
          {list.map((v) => (
            <li key={v.id}>
              <EventViewCard view={v} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="notice notice-info">No public events on the calendar yet. Yours could be the first.</p>
      )}
    </section>
  )
}

export function ListenCard() {
  const { config } = useEvConfig()
  const { data } = useNowPlaying(config.nowPlayingUrl, 30_000)
  const l = songLine(data?.now_playing)
  const online = data ? data.is_online !== false : null
  return (
    <a href="/listen" className="action-card">
      <span className="eyebrow">Listen</span>
      <span className="text-lg font-bold text-cream">EuphoricFM Event Radio</span>
      <span className="text-sm text-cream/75">
        {online === null ? 'Tune in to what is playing now.' : online ? `Now: ${l.artist ? `${l.artist} – ` : ''}${l.title || 'on air'}` : 'Between events it plays the EFM Events loop.'}
      </span>
      <span className="action-cue">Open the player ›</span>
    </a>
  )
}
