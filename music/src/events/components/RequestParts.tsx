'use client'

// Form sections shared by the one-page request form, the owner's edit page and
// staff booking: details, time (with live rule feedback and the day's
// availability), visibility.

import { useEffect, useMemo, useState } from 'react'
import { Notice } from '@/components/ui'
import { DESCRIPTION_MAX, HOST_NAME_MAX, LOCATION_MAX, TITLE_MAX } from '@/events/contract/rules'
import { EVENT_TYPES, type EventType, type Visibility } from '@/events/contract/types'
import { EV_COPY } from './copy'
import { EVENT_TYPE_LABEL } from './labels'
import { DAY, dateKey, formatDuration, formatIn, MIN, timeKey, zonedToUtc, zoneLabel } from './time'
import { listOf, type Busy } from './types'
import { useTz, When as WhenTime } from './tz'
import { type Details, lengthOptions, type TimeCheck, type When } from './wizard'

type FieldErrors = Partial<Record<keyof Details, string>>

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
      {hint ? <p className="ev-field-hint">{hint}</p> : null}
      {error ? (
        <p className="mt-1 text-xs text-rose-300" role="alert" id={`${id}-err`}>
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function DetailsFields({ value, onChange, errors, showErrors }: { value: Details; onChange: (d: Details) => void; errors: FieldErrors; showErrors: boolean }) {
  const set = <K extends keyof Details>(k: K, v: Details[K]) => onChange({ ...value, [k]: v })
  const err = (k: keyof Details) => (showErrors ? errors[k] : undefined)
  return (
    <div className="space-y-4">
      <Field id="ev-title" label="Event title (required)" error={err('title')} hint={`Up to ${TITLE_MAX} characters. Public events show it on the calendar.`}>
        <input id="ev-title" className="input" value={value.title} maxLength={TITLE_MAX + 20} onChange={(e) => set('title', e.target.value)} aria-invalid={!!err('title')} />
      </Field>
      <Field id="ev-type" label="Kind of event (required)" error={err('eventType')}>
        <select id="ev-type" className="input ev-select" value={value.eventType} onChange={(e) => set('eventType', e.target.value as EventType)} aria-invalid={!!err('eventType')}>
          <option value="">Choose…</option>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {EVENT_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </Field>
      <Field id="ev-host" label="Hosted by (optional)" error={err('hostName')} hint="A person, business or crew.">
        <input id="ev-host" className="input" value={value.hostName} maxLength={HOST_NAME_MAX + 20} onChange={(e) => set('hostName', e.target.value)} />
      </Field>
      <Field id="ev-loc" label="Where (optional)" error={err('location')} hint="The venue or area in the city.">
        <input id="ev-loc" className="input" value={value.location} maxLength={LOCATION_MAX + 20} onChange={(e) => set('location', e.target.value)} />
      </Field>
      <Field id="ev-desc" label="Description (optional)" error={err('description')} hint={`What guests should know. Up to ${DESCRIPTION_MAX} characters.`}>
        <textarea id="ev-desc" className="input min-h-[7rem]" value={value.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
    </div>
  )
}

/** Busy intervals around a day (member-only endpoint). */
export function useAvailability(date: string, enabled: boolean): { busy: Busy[]; loading: boolean; error: boolean } {
  const { zone } = useTz()
  const [state, setState] = useState<{ busy: Busy[]; loading: boolean; error: boolean }>({ busy: [], loading: false, error: false })
  useEffect(() => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? zonedToUtc(date, '00:00', zone) : null
    if (!enabled || !day) {
      setState({ busy: [], loading: false, error: false })
      return
    }
    let live = true
    setState((s) => ({ ...s, loading: true }))
    const from = new Date(day.getTime() - DAY).toISOString()
    const to = new Date(day.getTime() + 4 * DAY).toISOString()
    fetch(`/api/ev/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        return listOf<Busy>(await r.json())
      })
      .then((b) => live && setState({ busy: b, loading: false, error: false }))
      .catch(() => live && setState({ busy: [], loading: false, error: true }))
    return () => {
      live = false
    }
  }, [date, enabled, zone])
  return state
}

export function TimeFields({
  value,
  onChange,
  check,
  busy,
  busyLoading,
  busyError,
  maxHours,
  showErrors,
}: {
  value: When
  onChange: (w: When) => void
  check: TimeCheck
  busy: Busy[]
  busyLoading: boolean
  busyError: boolean
  maxHours: number
  showErrors: boolean
}) {
  const { mode, zone } = useTz()
  const zl = zoneLabel(Date.now(), mode)
  const lengths = useMemo(() => {
    const l = lengthOptions(maxHours)
    return l.includes(value.lengthMin) ? l : [...l, value.lengthMin].sort((a, b) => a - b)
  }, [maxHours, value.lengthMin])
  // Busy rows that touch the chosen day (in the chosen zone), events only.
  const dayStart = value.date ? zonedToUtc(value.date, '00:00', zone) : null
  const dayBusy = dayStart
    ? busy.filter((b) => b.kind === 'event' && Date.parse(b.startsAt) < dayStart.getTime() + DAY && Date.parse(b.endsAt) > dayStart.getTime())
    : []
  return (
    <div className="space-y-4">
      <p className="text-sm text-cream/75">
        Times are in <b>{mode === 'et' ? 'Eastern time (ET)' : `your time zone (${zl})`}</b>. Switch with the ET | Local toggle at the top.
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="ev-date" className="label">
            Date ({zl})
          </label>
          <input id="ev-date" type="date" className="input" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />
        </div>
        <div>
          <label htmlFor="ev-time" className="label">
            Start time ({zl})
          </label>
          <input id="ev-time" type="time" step={300} className="input" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />
        </div>
        <div>
          <label htmlFor="ev-len" className="label">
            Length
          </label>
          <select id="ev-len" className="input ev-select" value={value.lengthMin} onChange={(e) => onChange({ ...value, lengthMin: Number(e.target.value) })}>
            {lengths.map((m) => (
              <option key={m} value={m}>
                {formatDuration(m * MIN)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {check.startsAt && check.endsAt ? (
        <div className="rounded-xl border border-cream/15 bg-cream/[0.03] p-3 text-sm" data-testid="ev-time-summary">
          <p className="text-cream">
            <WhenTime at={check.startsAt} end={check.endsAt} />
          </p>
          {check.otherZone ? <p className="mt-1 text-xs text-cream/60">Starts {check.otherZone}</p> : null}
        </div>
      ) : null}

      {(showErrors || check.startsAt) && check.errors.length ? (
        <Notice tone="error">
          <ul className="list-disc space-y-1 pl-4" data-testid="ev-time-errors">
            {check.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {check.warnings.length ? (
        <Notice tone="warn">
          <ul className="list-disc space-y-1 pl-4" data-testid="ev-time-warnings">
            {check.warnings.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {check.startsAt && !check.errors.length ? <Notice tone="ok">This slot is free.</Notice> : null}

      <section aria-label="Already booked that day" className="space-y-2">
        <h3 className="text-sm font-semibold text-cream/85">Already booked that day</h3>
        {!value.date ? (
          <p className="text-xs text-cream/60">Pick a date to see what&apos;s booked.</p>
        ) : busyError ? (
          <p className="text-xs text-rose-200">Couldn&apos;t check the calendar. The team will check for clashes when you submit.</p>
        ) : busyLoading ? (
          <p className="text-xs text-cream/60">Checking…</p>
        ) : dayBusy.length ? (
          <ul className="space-y-1 text-sm text-cream/80">
            {dayBusy.map((b) => (
              <li key={`${b.startsAt}-${b.endsAt}`} className="flex items-center gap-2">
                <span className="ev-dot" data-kind="private" aria-hidden="true" />
                {formatIn(b.startsAt, mode, 'time')} – {formatIn(b.endsAt, mode, 'time')} {zoneLabel(b.startsAt, mode)} · booked
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-cream/60">Nothing booked that day.</p>
        )}
      </section>
    </div>
  )
}

export function VisibilityFields({ value, onChange, showErrors }: { value: Visibility | ''; onChange: (v: Visibility) => void; showErrors: boolean }) {
  return (
    <fieldset className="space-y-3">
      <legend className="label">Who can see the details?</legend>
      <label className="ev-choice">
        <input type="radio" name="ev-vis" value="public" checked={value === 'public'} onChange={() => onChange('public')} />
        <span>
          <span className="block font-semibold text-cream">Public</span>
          <span className="block text-sm text-cream/75">The calendar shows the title, host, place, description and time. Anyone can see it.</span>
        </span>
      </label>
      <label className="ev-choice">
        <input type="radio" name="ev-vis" value="private" checked={value === 'private'} onChange={() => onChange('private')} />
        <span>
          <span className="block font-semibold text-cream">Private</span>
          <span className="block text-sm text-cream/75">The calendar shows only &quot;Booked · Private event&quot; and the time.</span>
        </span>
      </label>
      <p className="text-xs text-cream/60">{EV_COPY.privateNowPlaying}</p>
      {showErrors && !value ? (
        <p className="text-xs text-rose-300" role="alert">
          Pick public or private.
        </p>
      ) : null}
    </fieldset>
  )
}

/** Split a UTC instant into the wizard's date/time inputs for a zone. */
export function toInputs(iso: string, zone: string | undefined): { date: string; time: string } {
  return { date: dateKey(iso, zone), time: timeKey(iso, zone) }
}
