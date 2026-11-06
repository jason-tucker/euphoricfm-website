'use client'

// "On now" / "Next up" for the Listen page, from the public calendar.

import { useEffect, useState } from 'react'
import { useJson } from '@/components/hooks'
import type { EventView } from '@/events/contract/types'
import { EventViewCard } from './EventViewCard'
import { DAY } from './time'
import { listOf } from './types'

export function CurrentEvent() {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  useEffect(() => {
    const now = Date.now()
    setRange({ from: new Date(now - 2 * DAY).toISOString(), to: new Date(now + 30 * DAY).toISOString() })
  }, [])
  const { data } = useJson<unknown>(range ? `/api/ev/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : null)
  if (!data) return null
  const now = Date.now()
  const views = listOf<EventView>(data)
    .filter((v) => v.kind !== 'pending' && Date.parse(v.endsAt) > now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  const on = views.find((v) => Date.parse(v.startsAt) <= now)
  const next = views.find((v) => Date.parse(v.startsAt) > now)
  if (!on && !next) return null
  return (
    <section className="space-y-2" aria-label={on ? 'On now' : 'Next event'}>
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-cream/70">{on ? 'On now' : 'Next event'}</h2>
      <EventViewCard view={(on ?? next)!} />
    </section>
  )
}
