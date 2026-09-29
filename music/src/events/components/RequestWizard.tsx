'use client'

// The request wizard: details → time → visibility → playlist → review →
// submit. The draft is created (POST /api/ev/events) when leaving the
// visibility step, the playlist saved (PUT …/playlist) when leaving the
// playlist step, and submit (POST …/submit) opens the Discord ticket.

import { useMemo, useState } from 'react'
import { Notice } from '@/components/ui'
import { api, evMessage } from './ev-api'
import { useEvConfig, useNow } from './hooks'
import { EVENT_TYPE_LABEL } from './labels'
import { PlaylistBuilder } from './PlaylistBuilder'
import { type Builder, builderProblems, runningLength, toPayload } from './playlist'
import { DetailsFields, TimeFields, useAvailability, VisibilityFields } from './RequestParts'
import { formatDuration, formatIn, zoneLabel } from './time'
import type { FullView } from './types'
import { useTz, When } from './tz'
import { checkDetails, checkTime, type Draft, EMPTY_DRAFT, enteredTz, withoutSelf } from './wizard'

export const STEPS = ['Details', 'Time', 'Visibility', 'Playlist', 'Review'] as const

export function detailsBody(d: Draft, startsAt: string, endsAt: string, mode: 'et' | 'local') {
  return {
    title: d.title.trim(),
    hostName: d.hostName.trim() || null,
    description: d.description.trim() || null,
    location: d.location.trim() || null,
    eventType: d.eventType || 'other',
    startsAt,
    endsAt,
    enteredTz: enteredTz(mode),
    visibility: d.visibility || 'public',
  }
}

export function StepBar({ step, onGo, maxReached }: { step: number; onGo: (i: number) => void; maxReached: number }) {
  return (
    <ol className="ev-steps" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li key={s}>
          <button type="button" className="ev-step" aria-current={i === step ? 'step' : undefined} data-done={i < step} disabled={i > maxReached} onClick={() => onGo(i)}>
            {i + 1}. {s}
          </button>
        </li>
      ))}
    </ol>
  )
}

export function RequestWizard({ staff }: { staff: boolean }) {
  const { config, loaded } = useEvConfig()
  const { mode } = useTz()
  const now = useNow(30_000)
  const [step, setStep] = useState(0)
  const [maxReached, setMaxReached] = useState(0)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [builder, setBuilder] = useState<Builder>({ tracks: [], anns: [], order: 'shuffle' })
  const [saved, setSaved] = useState<FullView | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [done, setDone] = useState<FullView | null>(null)

  const avail = useAvailability(draft.date, true)
  const detailErrors = checkDetails(draft)
  const time = checkTime({ when: draft, mode, now, config, staff, busy: withoutSelf(avail.busy, saved) })
  const problems = useMemo(() => (time.startsAt && time.endsAt ? builderProblems(builder, time.startsAt, time.endsAt, config.maxRows) : []), [builder, time.startsAt, time.endsAt, config.maxRows])

  if (loaded && !config.eventsEnabled && !staff) {
    return (
      <Notice tone="warn">
        Event requests open soon. For now, only the EuphoricFM team can book events here. Look around the calendar, or ask in the EuphoricFM Discord.
      </Notice>
    )
  }

  const stepValid = (i: number): boolean => {
    if (i === 0) return Object.keys(detailErrors).length === 0
    if (i === 1) return !time.errors.length && !!time.startsAt
    if (i === 2) return !!draft.visibility
    if (i === 3) return problems.length === 0
    return true
  }

  const saveEvent = async (): Promise<FullView | null> => {
    if (!time.startsAt || !time.endsAt) return null
    const body = detailsBody(draft, time.startsAt, time.endsAt, mode)
    const r = saved
      ? await api<{ event: FullView }>(`/api/ev/events/${saved.id}`, { method: 'PATCH', json: { ...body, version: saved.version } })
      : await api<{ event: FullView }>('/api/ev/events', { json: { ...body, playlistOrder: builder.order } })
    setSaved(r.event)
    return r.event
  }

  // Saves the playlist of the draft (with its version) and keeps the returned view.
  const savePlaylist = async (ev: FullView): Promise<FullView> => {
    const r = await api<{ event: FullView }>(`/api/ev/events/${ev.id}/playlist`, { method: 'PUT', json: { ...toPayload(builder), version: ev.version } })
    setSaved(r.event)
    return r.event
  }

  const next = async () => {
    setApiError(null)
    if (!stepValid(step)) {
      setShowErrors(true)
      return
    }
    setShowErrors(false)
    setBusy(true)
    try {
      if (step === 2) await saveEvent()
      if (step === 3 && saved) await savePlaylist(saved)
      const n = step + 1
      setStep(n)
      setMaxReached((m) => Math.max(m, n))
      window.scrollTo?.({ top: 0 })
    } catch (e) {
      setApiError(evMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!saved) return
    setApiError(null)
    setBusy(true)
    try {
      const ev = (await saveEvent()) ?? saved
      await savePlaylist(ev)
      const r = await api<{ event: FullView }>(`/api/ev/events/${saved.id}/submit`, { json: {} })
      setDone(r.event)
    } catch (e) {
      setApiError(evMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <section className="card space-y-4" aria-live="polite">
        <h2 className="text-2xl font-bold text-sunburst">Request sent</h2>
        <p className="text-cream/85">
          Thanks! Your request for <b>{done.title}</b> (<When at={done.startsAt} end={done.endsAt} />) is waiting for review. It holds its slot on the calendar as &quot;Pending&quot;.
        </p>
        <p className="text-cream/85">A ticket opens in the EuphoricFM Discord in a minute or two. The team will talk to you there.</p>
        <div className="flex flex-wrap gap-3">
          {done.ticketUrl ? (
            <a className="btn btn-discord" href={done.ticketUrl} target="_blank" rel="noopener noreferrer">
              Open your ticket ↗
            </a>
          ) : null}
          <a className="btn btn-primary" href={`/my/events/${done.id}`}>
            View your request
          </a>
          <a className="btn btn-secondary" href="/my">
            My events
          </a>
        </div>
      </section>
    )
  }

  const run = runningLength(builder.tracks)
  return (
    <div className="space-y-5">
      <StepBar step={step} maxReached={maxReached} onGo={(i) => setStep(i)} />
      {!config.eventsEnabled && staff ? <Notice tone="info">Requests are closed to members right now; you can book because you are staff.</Notice> : null}
      <section className="card space-y-5">
        <h2 className="text-xl font-bold text-cream">
          {step + 1}. {STEPS[step]}
        </h2>
        {step === 0 ? <DetailsFields value={draft} onChange={(d) => setDraft({ ...draft, ...d })} errors={detailErrors} showErrors={showErrors} /> : null}
        {step === 1 ? (
          <TimeFields
            value={draft}
            onChange={(w) => setDraft({ ...draft, ...w })}
            check={time}
            busy={avail.busy}
            busyLoading={avail.loading}
            busyError={avail.error}
            maxHours={staff ? 72 : config.memberMaxHours}
            showErrors={showErrors}
          />
        ) : null}
        {step === 2 ? <VisibilityFields value={draft.visibility} onChange={(v) => setDraft({ ...draft, visibility: v })} showErrors={showErrors} /> : null}
        {step === 3 && time.startsAt && time.endsAt ? (
          <>
            <PlaylistBuilder value={builder} onChange={setBuilder} start={time.startsAt} end={time.endsAt} maxRows={config.maxRows} uploadsEnabled={config.uploadsEnabled} />
            {showErrors && problems.length ? (
              <Notice tone="error">
                <ul className="list-disc space-y-1 pl-4">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
          </>
        ) : null}
        {step === 4 && time.startsAt && time.endsAt ? (
          <div className="space-y-4">
            <dl className="facts">
              <dt>Title</dt>
              <dd>{draft.title}</dd>
              <dt>Kind</dt>
              <dd>{draft.eventType ? EVENT_TYPE_LABEL[draft.eventType] : ''}</dd>
              {draft.hostName ? (
                <>
                  <dt>Host</dt>
                  <dd>{draft.hostName}</dd>
                </>
              ) : null}
              {draft.location ? (
                <>
                  <dt>Where</dt>
                  <dd>{draft.location}</dd>
                </>
              ) : null}
              <dt>When</dt>
              <dd>
                <When at={time.startsAt} end={time.endsAt} />
                <span className="block text-xs text-cream/60">Starts {time.otherZone}</span>
              </dd>
              <dt>Visibility</dt>
              <dd>{draft.visibility === 'private' ? 'Private (calendar shows "Booked · Private event")' : 'Public'}</dd>
              <dt>Songs</dt>
              <dd>
                {builder.tracks.length} ({formatDuration(run.seconds * 1000)}, {builder.order === 'shuffle' ? 'shuffled' : 'in your order'}), {builder.tracks.filter((t) => t.pinAt).length} pinned
              </dd>
              <dt>Announcements</dt>
              <dd>{builder.anns.length}</dd>
            </dl>
            {time.warnings.length ? (
              <Notice tone="warn">
                <ul className="list-disc space-y-1 pl-4">
                  {time.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            <p className="text-sm text-cream/75">
              Submitting opens a ticket in the EuphoricFM Discord. You can still change the request from My events until {config.freezeMin} minutes before it starts
              {` (${formatIn(Date.parse(time.startsAt) - config.freezeMin * 60_000, mode, 'short')} ${zoneLabel(time.startsAt, mode)})`}.
            </p>
          </div>
        ) : null}

        {showErrors && !stepValid(step) && step !== 3 ? (
          <p className="text-sm text-rose-300" role="alert" data-testid="ev-step-error">
            {step === 1 ? 'Fix the time above to continue.' : step === 2 ? 'Pick public or private to continue.' : 'Fix the fields above to continue.'}
          </p>
        ) : null}
        {apiError ? <Notice tone="error">{apiError}</Notice> : null}

        <div className="flex flex-wrap gap-3">
          {step > 0 ? (
            <button type="button" className="btn btn-secondary" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </button>
          ) : null}
          {step < 4 ? (
            <button type="button" className="btn btn-primary" onClick={() => void next()} disabled={busy}>
              {busy ? 'Saving…' : step === 2 ? 'Save and build the playlist' : 'Continue'}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || !saved}>
              {busy ? 'Submitting…' : 'Submit request'}
            </button>
          )}
          {saved ? (
            <a className="btn btn-secondary" href={`/my/events/${saved.id}`}>
              Finish later (saved as a draft)
            </a>
          ) : null}
        </div>
      </section>
    </div>
  )
}
