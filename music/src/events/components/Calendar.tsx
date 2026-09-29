'use client'

// The public calendar: month grid (tap a day for its list) or agenda list,
// in ET or the viewer's zone. Renders the EventView projections exactly:
// public details, "Booked · Private event", "Pending".

import { useEffect, useMemo, useState } from 'react'
import { useJson } from '@/components/hooks'
import type { EventView } from '@/events/contract/types'
import { EventViewCard, project } from './EventViewCard'
import { dateKey, daysTouched, formatIn, isMonthKey, monthGrid, monthKey, monthRange, shiftMonth, zonedToUtc } from './time'
import { listOf } from './types'
import { useTz } from './tz'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export type CalView = 'grid' | 'list'

/** Views bucketed by the date keys (in `zone`) each one touches, sorted by start. */
export function bucketByDay(views: EventView[], zone: string | undefined): Map<string, EventView[]> {
  const m = new Map<string, EventView[]>()
  const sorted = [...views].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  for (const v of sorted) {
    for (const k of daysTouched(v.startsAt, v.endsAt, zone)) {
      const arr = m.get(k) ?? []
      arr.push(v)
      m.set(k, arr)
    }
  }
  return m
}

function monthTitle(m: string): string {
  const d = zonedToUtc(`${m}-15`, '12:00', 'UTC')!
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d)
}

function dayTitle(k: string): string {
  const d = zonedToUtc(k, '12:00', 'UTC')!
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d)
}

export function Calendar({ initialMonth, initialView }: { initialMonth: string | null; initialView: CalView }) {
  const { zone, mode } = useTz()
  const [month, setMonth] = useState<string | null>(isMonthKey(initialMonth) ? initialMonth : null)
  const [view, setView] = useState<CalView>(initialView)
  const [selected, setSelected] = useState<string | null>(null)
  const [today, setToday] = useState<string | null>(null)

  // The current month depends on the zone and the clock: decide on the client.
  useEffect(() => {
    setToday(dateKey(Date.now(), zone))
    setMonth((m) => m ?? monthKey(Date.now(), zone))
  }, [zone])

  useEffect(() => {
    if (!month) return
    const u = new URL(window.location.href)
    u.searchParams.set('m', month)
    if (view === 'list') u.searchParams.set('view', 'list')
    else u.searchParams.delete('view')
    window.history.replaceState(null, '', `${u.pathname}${u.search}`)
  }, [month, view])

  const range = month ? monthRange(month, zone) : null
  const { data, error, loading } = useJson<unknown>(range ? `/api/ev/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : null)
  const views = useMemo(() => listOf<EventView>(data), [data])
  const byDay = useMemo(() => bucketByDay(views, zone), [views, zone])
  const monthDays = useMemo(() => (month ? [...byDay.keys()].filter((k) => k.startsWith(month)).sort() : []), [byDay, month])

  const go = (by: number) => {
    setSelected(null)
    setMonth((m) => (m ? shiftMonth(m, by) : m))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" className="ev-iconbtn" onClick={() => go(-1)} aria-label="Previous month">
            ‹
          </button>
          <h2 className="min-w-[10rem] text-center text-lg font-bold text-cream" aria-live="polite">
            {month ? monthTitle(month) : ' '}
          </h2>
          <button type="button" className="ev-iconbtn" onClick={() => go(1)} aria-label="Next month">
            ›
          </button>
          {today && month !== today.slice(0, 7) ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonth(today.slice(0, 7))}>
              Today
            </button>
          ) : null}
        </div>
        <div className="ev-seg" role="group" aria-label="Calendar view">
          <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
            Month
          </button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            List
          </button>
        </div>
      </div>

      <ul className="flex flex-wrap gap-4 text-xs text-cream/70" aria-label="Legend">
        <li className="flex items-center gap-2">
          <span className="ev-dot" data-kind="public" /> Public event
        </li>
        <li className="flex items-center gap-2">
          <span className="ev-dot" data-kind="private" /> Booked · Private event
        </li>
        <li className="flex items-center gap-2">
          <span className="ev-dot" data-kind="pending" /> Pending review
        </li>
      </ul>

      {error ? <p className="notice notice-error">Couldn&apos;t load the calendar. Try again in a minute.</p> : null}
      {loading && !data ? <p className="text-sm text-cream/60">Loading…</p> : null}

      {month && view === 'grid' ? (
        <>
          <div className="ev-cal" role="grid" aria-label={monthTitle(month)}>
            {WEEKDAYS.map((w) => (
              <div key={w} className="ev-cal-h" role="columnheader">
                {w}
              </div>
            ))}
            {monthGrid(month)
              .flat()
              .map((c) => {
                const evs = byDay.get(c.key) ?? []
                const label = `${dayTitle(c.key)}: ${evs.length ? `${evs.length} event${evs.length > 1 ? 's' : ''}` : 'nothing booked'}`
                return (
                  <div key={c.key} className="ev-cal-day" data-out={!c.inMonth} data-today={c.key === today} role="gridcell">
                    <button type="button" className="ev-cal-num text-left" onClick={() => setSelected(c.key)} aria-label={label} aria-pressed={selected === c.key}>
                      {c.day}
                    </button>
                    {evs.slice(0, 3).map((v) => {
                      const p = project(v)
                      const text = `${formatIn(p.startsAt, mode, 'time')} ${p.heading}`
                      return (
                        <button key={v.id} type="button" className="ev-cal-ev" data-kind={p.kind} onClick={() => setSelected(c.key)} aria-label={`${text}, ${dayTitle(c.key)}`} title={text}>
                          {text}
                        </button>
                      )
                    })}
                    {evs.length > 3 ? <span className="text-[10px] text-cream/60">+{evs.length - 3}</span> : null}
                  </div>
                )
              })}
          </div>
          <DayList day={selected ?? (today && today.startsWith(month) ? today : null)} views={selected || today ? (byDay.get(selected ?? today ?? '') ?? []) : []} />
        </>
      ) : null}

      {month && view === 'list' ? (
        monthDays.length ? (
          <div className="space-y-5">
            {monthDays.map((k) => (
              <DayList key={k} day={k} views={byDay.get(k) ?? []} />
            ))}
          </div>
        ) : data ? (
          <p className="notice notice-info">Nothing booked in {monthTitle(month)} yet.</p>
        ) : null
      ) : null}
    </div>
  )
}

function DayList({ day, views }: { day: string | null; views: EventView[] }) {
  if (!day) return <p className="text-sm text-cream/60">Tap a day to see what&apos;s booked.</p>
  return (
    <section aria-label={dayTitle(day)} className="space-y-2">
      <h3 className="text-sm font-bold text-cream/85">{dayTitle(day)}</h3>
      {views.length ? (
        <ul className="space-y-2">
          {views.map((v) => (
            <li key={v.id}>
              <EventViewCard view={v} showDescription />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-cream/60">Nothing booked.</p>
      )}
    </section>
  )
}
