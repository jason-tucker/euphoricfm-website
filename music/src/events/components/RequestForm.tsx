'use client'

// The one-page request form (0.5.3), for a new request (/request) and for
// editing a draft (/my/events/:id): Details · Date & time · Visibility ·
// Songs · Announcements · Review & submit. It saves itself (autosave.ts):
// a local backup of the whole form at every change, the draft created on
// the server as soon as its minimum is valid, then debounced PATCH/PUT saves.
// Playlist rule problems never block a draft save (the API stores any
// structurally valid draft playlist); they are shown live and block Submit.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Notice } from '@/components/ui'
import { type Backup, backupKey, clearBackup, DraftSaver, payloadKey, readBackup, type SavePlan, type SaveStatus, writeBackup } from './autosave'
import { api, evMessage } from './ev-api'
import { builderFromView, draftFromView, patchFor } from './fromView'
import { rulesList } from './HomeParts'
import { useEvConfig, useNow } from './hooks'
import { EVENT_TYPE_LABEL } from './labels'
import { AnnouncementsEditor, RowsNote, SongsEditor, useAudioSources } from './PlaylistBuilder'
import { type Builder, builderProblems, runningLength, toPayload } from './playlist'
import { DetailsFields, TimeFields, toInputs, useAvailability, VisibilityFields } from './RequestParts'
import { formatDuration, formatIn, zoneLabel } from './time'
import type { AudioItem, FullView, Stinger } from './types'
import { useTz, When } from './tz'
import { checkDetails, checkTime, type Draft, EMPTY_DRAFT, enteredTz, withoutSelf } from './wizard'

export const SECTIONS = [
  { id: 'rf-details', label: 'Details' },
  { id: 'rf-time', label: 'Date & time' },
  { id: 'rf-vis', label: 'Visibility' },
  { id: 'rf-songs', label: 'Songs' },
  { id: 'rf-anns', label: 'Announcements' },
  { id: 'rf-review', label: 'Review & submit' },
] as const

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

type FormData = { draft: Draft; builder: Builder; startsAt: string | null; key: string }

const EMPTY_BUILDER: Builder = { tracks: [], anns: [], order: 'shuffle' }

type Props = {
  staff: boolean
  /** The signed-in member (Discord id): the local backup is per user. */
  userKey: string
  chunkBytes: number
  /** An existing draft (from /my/events/:id); absent for a new request. */
  initial?: FullView
  audio?: AudioItem[]
  stingers?: Stinger[]
  /** Test hooks. */
  debounceMs?: number
  retryBaseMs?: number
}

export function RequestForm(props: Props) {
  const { config, loaded } = useEvConfig()
  if (loaded && !config.eventsEnabled && !props.staff && !props.initial) {
    return (
      <Notice tone="warn">
        Event requests open soon. For now, only the EuphoricFM team can book events here. Look around the calendar, or ask in the EuphoricFM Discord.
      </Notice>
    )
  }
  return <FormBody {...props} />
}

function FormBody({ staff, userKey, chunkBytes, initial, audio = [], stingers = [], debounceMs, retryBaseMs }: Props) {
  const { config } = useEvConfig()
  const { mode, zone } = useTz()
  const now = useNow(30_000)
  const [view, setView] = useState<FullView | null>(initial ?? null)
  const [draft, setDraft] = useState<Draft>(() => (initial ? draftFromView(initial, zone) : EMPTY_DRAFT))
  const [builder, setBuilder] = useState<Builder>(() => (initial ? builderFromView(initial, audio, stingers) : EMPTY_BUILDER))
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' })
  const [restored, setRestored] = useState(false)
  const [storageOk, setStorageOk] = useState(true)
  const [showErrors, setShowErrors] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState<string | null>(null)
  const [done, setDone] = useState<FullView | null>(null)
  const [discard, setDiscard] = useState<'ask' | 'busy' | null>(null)
  const sources = useAudioSources()

  const avail = useAvailability(draft.date, true)
  const detailErrors = checkDetails(draft)
  const time = checkTime({ when: draft, mode, now, config, staff, busy: withoutSelf(avail.busy, view) })
  const timeOk = !time.errors.length && !!time.startsAt && !!time.endsAt
  const problems = useMemo(() => (time.startsAt && time.endsAt ? builderProblems(builder, time.startsAt, time.endsAt, config.maxRows) : []), [builder, time.startsAt, time.endsAt, config.maxRows])
  const payload = useMemo(() => toPayload(builder), [builder])
  const pKey = useMemo(() => payloadKey(payload), [payload])
  const formKey = JSON.stringify({
    t: draft.title.trim(),
    h: draft.hostName.trim(),
    d: draft.description.trim(),
    l: draft.location.trim(),
    e: draft.eventType,
    v: draft.visibility,
    s: time.startsAt ?? `${draft.date}|${draft.time}`,
    n: draft.lengthMin,
    p: pKey,
  })

  const missing: string[] = []
  if (detailErrors.title) missing.push(draft.title.trim() ? 'a shorter title' : 'a title')
  if (detailErrors.eventType) missing.push('the kind of event')
  if (!draft.date || !draft.time) missing.push('a date and start time')
  else if (!timeOk) missing.push('a time that fits the rules')
  if (!draft.visibility) missing.push('public or private')
  if (detailErrors.hostName || detailErrors.location || detailErrors.description) missing.push('shorter host, place or description')

  // What the server is missing, from the latest form (autosave.ts calls it
  // at the start of every save, so a retry always sends the newest data).
  const plan = (v: FullView | null): SavePlan => {
    if (!v) {
      const create = missing.length || !time.startsAt || !time.endsAt ? null : { ...detailsBody(draft, time.startsAt, time.endsAt, mode), playlistOrder: builder.order }
      return { key: formKey, create, missing, patch: {}, playlist: null, blocked: [] }
    }
    // Invalid fields keep the saved value (and stay on this device).
    const eff: Draft = {
      ...draft,
      title: detailErrors.title ? v.title : draft.title,
      hostName: detailErrors.hostName ? (v.hostName ?? '') : draft.hostName,
      location: detailErrors.location ? (v.location ?? '') : draft.location,
      description: detailErrors.description ? (v.description ?? '') : draft.description,
      eventType: draft.eventType || v.eventType,
      visibility: draft.visibility || v.visibility,
    }
    const patch = patchFor(v, eff, timeOk ? time.startsAt : null, timeOk ? time.endsAt : null, enteredTz(mode))
    const playlist = payloadKey({ tracks: v.tracks, announcements: v.announcements, playlistOrder: v.playlistOrder }) === pKey ? null : payload
    const blocked: string[] = []
    if (Object.keys(detailErrors).length) blocked.push(`Fix ${missing.filter((m) => !m.includes('time') && !m.includes('public')).join(', ') || 'the details'} above.`)
    const timeMoved = time.startsAt !== null && (Date.parse(time.startsAt) !== Date.parse(v.startsAt) || Date.parse(time.endsAt ?? '') !== Date.parse(v.endsAt))
    if (!timeOk && (timeMoved || !time.startsAt)) blocked.push('The new date and time are saved once they fit the rules.')
    return { key: formKey, create: null, missing: [], patch, playlist, blocked }
  }
  const planRef = useRef(plan)
  planRef.current = plan
  const formKeyRef = useRef(formKey)
  formKeyRef.current = formKey
  const synced = useRef<string>(formKey)
  const viewRef = useRef(view)
  viewRef.current = view

  const saver = useMemo(
    () =>
      new DraftSaver({
        initial: initial ?? null,
        plan: (v) => planRef.current(v),
        onView: (v) => {
          const first = !viewRef.current
          viewRef.current = v
          setView(v)
          if (first) {
            // The new draft now has a home: move the backup, and make a
            // reload open the draft itself.
            clearBackup(backupKey(userKey, 'new'))
            try {
              window.history.replaceState(window.history.state, '', `/my/events/${v.id}`)
            } catch {
              // not fatal
            }
          }
        },
        onStatus: setStatus,
        onSynced: (key) => {
          synced.current = key
          if (key === formKeyRef.current && viewRef.current) clearBackup(backupKey(userKey, viewRef.current.id))
        },
        debounceMs,
        retryBaseMs,
      }),
    // one saver for the life of the form
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Restore a local backup that is newer than the server copy (it exists
  // only while changes were not saved).
  const mounted = useRef(false)
  // Bumped when the form is reset to the saved copy (or emptied): the key
  // rendered after the reset is in sync (declared before the backup effect).
  const [resetN, setResetN] = useState(0)
  useEffect(() => {
    if (resetN) synced.current = formKey
    // only on a reset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetN])
  useEffect(() => {
    const b = readBackup<FormData>(backupKey(userKey, initial?.id ?? 'new'))
    if (b && (!initial || b.eventId === initial.id) && b.data.key !== synced.current) {
      const d = b.data.startsAt ? { ...b.data.draft, ...toInputs(b.data.startsAt, zone) } : b.data.draft
      setDraft({ ...EMPTY_DRAFT, ...d })
      setBuilder({ ...EMPTY_BUILDER, ...b.data.builder })
      setRestored(true)
    }
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Every change: back it up on this device, then (debounced) to the server.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const k = backupKey(userKey, view?.id ?? 'new')
    if (formKey === synced.current) {
      clearBackup(k)
      return
    }
    const b: Backup<FormData> = { v: 1, savedAt: Date.now(), eventId: view?.id ?? null, baseVersion: view?.version ?? null, data: { draft, builder, startsAt: time.startsAt, key: formKey } }
    setStorageOk(writeBackup(k, b))
    saver.touch()
    // formKey covers draft + builder
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey, view?.id])

  // Leaving or hiding the page: send the last changes with keepalive.
  const dirtyRef = useRef(false)
  dirtyRef.current = formKey !== synced.current
  useEffect(() => {
    saver.revive()
    const flush = () => {
      if (dirtyRef.current) saver.flushKeepalive()
    }
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    const onOnline = () => void saver.kick()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flush)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('online', onOnline)
      flush()
      saver.stop()
    }
  }, [saver])

  // Flipping ET ⇄ Local keeps the chosen instant: re-split the date and time
  // inputs from the start computed in the previous zone.
  const lastStart = useRef<{ zone: string | undefined; startsAt: string | null }>({ zone, startsAt: null })
  useEffect(() => {
    const prev = lastStart.current
    if (prev.zone !== zone && prev.startsAt) {
      const startsAt = prev.startsAt
      setDraft((d) => ({ ...d, ...toInputs(startsAt, zone) }))
    }
  }, [zone])
  useEffect(() => {
    lastStart.current = { zone, startsAt: time.startsAt }
  })

  const revertToSaved = () => {
    if (!initial) {
      // a new request: start over with an empty form
      clearBackup(backupKey(userKey, 'new'))
      setResetN((n) => n + 1)
      setDraft(EMPTY_DRAFT)
      setBuilder(EMPTY_BUILDER)
      setRestored(false)
      return
    }
    const v = viewRef.current ?? initial
    clearBackup(backupKey(userKey, v.id))
    setResetN((n) => n + 1)
    setDraft(draftFromView(v, zone))
    setBuilder(builderFromView(v, sources.audio.length ? sources.audio : audio, sources.stingers.length ? sources.stingers : stingers))
    setRestored(false)
  }

  // Everything that stops a submit (shown after the first Submit press).
  const blockers: string[] = [
    ...Object.values(detailErrors),
    ...(time.startsAt ? time.errors : ['Pick a date and a start time.']),
    ...(draft.visibility ? [] : ['Pick public or private.']),
    ...problems,
  ].filter((x): x is string => !!x)

  const submit = async () => {
    setShowErrors(true)
    setSubmitErr(null)
    if (blockers.length) return
    setSubmitting(true)
    try {
      const ok = await saver.flush()
      const v = saver.view
      if (!ok || !v) {
        setSubmitErr("Your latest changes aren't saved yet, so the request was not sent. Check the save status above and try again.")
        return
      }
      const r = await api<{ event: FullView }>(`/api/ev/events/${v.id}/submit`, { json: {} })
      saver.stop()
      clearBackup(backupKey(userKey, v.id))
      clearBackup(backupKey(userKey, 'new'))
      setDone(r.event)
      window.scrollTo?.({ top: 0 })
    } catch (e) {
      setSubmitErr(evMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  const discardDraft = async () => {
    const v = saver.view
    if (!v) return
    setDiscard('busy')
    try {
      saver.stop()
      await api(`/api/ev/events/${v.id}/withdraw`, { json: {} })
      clearBackup(backupKey(userKey, v.id))
      window.location.assign('/my')
    } catch (e) {
      saver.revive()
      setSubmitErr(evMessage(e))
      setDiscard(null)
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

  const statusView = <SaveStatusText status={status} view={view} missing={missing} dirty={formKey !== synced.current} storageOk={storageOk} mode={mode} />
  const run = runningLength(builder.tracks)
  const editors = { value: builder, onChange: setBuilder, start: time.startsAt, end: time.endsAt, sources, uploadsEnabled: config.uploadsEnabled, chunkBytes }

  return (
    <div className="space-y-5">
      <div className="ev-savebar card" data-testid="rf-status-top">
        <p className="text-sm" aria-live="polite" role="status">
          {statusView}
        </p>
        <nav aria-label="Form sections">
          <ol className="ev-steps">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a className="ev-step" href={`#${s.id}`}>
                  {s.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
      {!config.eventsEnabled && staff ? <Notice tone="info">Requests are closed to members right now; you can book because you are staff.</Notice> : null}
      {restored ? (
        <Notice tone="info">
          We restored changes you made on this device that hadn&apos;t been saved yet. They save automatically now.
          {initial || !view ? (
            <>
              {' '}
              <button type="button" className="link" onClick={revertToSaved}>
                {initial ? 'Use the saved version instead' : 'Start over'}
              </button>
            </>
          ) : null}
        </Notice>
      ) : null}

      <section id="rf-details" className="card space-y-5" aria-labelledby="rf-details-h">
        <h2 id="rf-details-h" className="text-xl font-bold text-cream">
          Details
        </h2>
        <DetailsFields value={draft} onChange={(d) => setDraft((x) => ({ ...x, ...d }))} errors={detailErrors} showErrors={showErrors || !!view} />
      </section>

      <section id="rf-time" className="card space-y-5" aria-labelledby="rf-time-h">
        <h2 id="rf-time-h" className="text-xl font-bold text-cream">
          Date &amp; time
        </h2>
        <TimeFields
          value={draft}
          onChange={(w) => setDraft((x) => ({ ...x, ...w }))}
          check={time}
          busy={withoutSelf(avail.busy, view)}
          busyLoading={avail.loading}
          busyError={avail.error}
          maxHours={staff ? 72 : config.memberMaxHours}
          showErrors={showErrors}
        />
      </section>

      <section id="rf-vis" className="card space-y-5" aria-labelledby="rf-vis-h">
        <h2 id="rf-vis-h" className="text-xl font-bold text-cream">
          Visibility
        </h2>
        <VisibilityFields value={draft.visibility} onChange={(v) => setDraft((x) => ({ ...x, visibility: v }))} showErrors={showErrors} />
      </section>

      <section id="rf-songs" className="card space-y-5" aria-labelledby="rf-songs-h">
        <h2 id="rf-songs-h" className="text-xl font-bold text-cream">
          Songs
        </h2>
        <SongsEditor {...editors} />
      </section>

      <section id="rf-anns" className="card space-y-5" aria-labelledby="rf-anns-h">
        <h2 id="rf-anns-h" className="text-xl font-bold text-cream">
          Announcements
        </h2>
        <AnnouncementsEditor {...editors} />
        {time.startsAt && time.endsAt ? <RowsNote value={builder} start={time.startsAt} end={time.endsAt} maxRows={config.maxRows} /> : null}
      </section>

      <section id="rf-review" className="card space-y-4" aria-labelledby="rf-review-h">
        <h2 id="rf-review-h" className="text-xl font-bold text-cream">
          Review &amp; submit
        </h2>
        <dl className="facts">
          <dt>Title</dt>
          <dd>{draft.title.trim() || '—'}</dd>
          <dt>Kind</dt>
          <dd>{draft.eventType ? EVENT_TYPE_LABEL[draft.eventType] : '—'}</dd>
          {draft.hostName.trim() ? (
            <>
              <dt>Host</dt>
              <dd>{draft.hostName}</dd>
            </>
          ) : null}
          {draft.location.trim() ? (
            <>
              <dt>Where</dt>
              <dd>{draft.location}</dd>
            </>
          ) : null}
          <dt>When</dt>
          <dd>
            {time.startsAt && time.endsAt ? (
              <>
                <When at={time.startsAt} end={time.endsAt} />
                {time.otherZone ? <span className="block text-xs text-cream/60">Starts {time.otherZone}</span> : null}
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt>Visibility</dt>
          <dd>{draft.visibility === 'private' ? 'Private (calendar shows "Booked · Private event")' : draft.visibility === 'public' ? 'Public' : '—'}</dd>
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
        {problems.length && !showErrors ? (
          <Notice tone="warn">
            <p>Your draft is saved, but these need fixing before you can submit:</p>
            <ul className="mt-1 list-disc space-y-1 pl-4" data-testid="rf-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <details className="disclosure">
          <summary>The rules, in plain words</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-cream/80">
            {rulesList(config).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
        <p className="text-sm text-cream/75">
          Submitting opens a ticket in the EuphoricFM Discord. You can still change the request from My events until {config.freezeMin} minutes before it starts
          {time.startsAt ? ` (${formatIn(Date.parse(time.startsAt) - config.freezeMin * 60_000, mode, 'short')} ${zoneLabel(time.startsAt, mode)})` : ''}.
        </p>
        {showErrors && blockers.length ? (
          <Notice tone="error">
            <p>Fix these before you submit:</p>
            <ul className="mt-1 list-disc space-y-1 pl-4" data-testid="rf-blockers">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {submitErr ? <Notice tone="error">{submitErr}</Notice> : null}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit request'}
          </button>
          {view ? (
            <a className="btn btn-secondary" href="/my">
              Finish later (saved as a draft)
            </a>
          ) : null}
        </div>
        <p className="text-sm" data-testid="rf-status-bottom" aria-hidden="true">
          {statusView}
        </p>
      </section>

      {view ? (
        <section className="card space-y-2">
          <h2 className="text-lg font-bold text-cream">Discard this draft</h2>
          <p className="text-sm text-cream/75">This deletes the draft. It can&apos;t be undone.</p>
          <button type="button" className="btn btn-danger" disabled={discard === 'busy'} onClick={() => setDiscard('ask')}>
            Discard draft
          </button>
        </section>
      ) : null}
      <ConfirmDialog
        open={discard !== null}
        title="Discard this draft?"
        confirmLabel="Discard"
        confirmClass="btn-danger"
        busy={discard === 'busy'}
        onConfirm={() => void discardDraft()}
        onCancel={() => setDiscard(null)}
      >
        <p>&quot;{view?.title}&quot; will be deleted.</p>
      </ConfirmDialog>
    </div>
  )
}

function SaveStatusText({
  status,
  view,
  missing,
  dirty,
  storageOk,
  mode,
}: {
  status: SaveStatus
  view: FullView | null
  missing: string[]
  dirty: boolean
  storageOk: boolean
  mode: 'et' | 'local'
}) {
  const local = storageOk ? ' Your changes are kept on this device.' : ''
  if (!view && (status.kind === 'idle' || status.kind === 'new')) {
    return missing.length ? (
      <span className="ev-save" data-state="new">
        Draft not saved yet — add {missing.join(', ')}.
      </span>
    ) : (
      <span className="ev-save" data-state="saving">
        Saving…
      </span>
    )
  }
  switch (status.kind) {
    case 'saving':
      return (
        <span className="ev-save" data-state="saving">
          Saving…
        </span>
      )
    case 'offline':
      return (
        <span className="ev-save" data-state="offline">
          {storageOk ? 'Offline — saved on this device' : 'Offline — not saved yet. Keep this page open.'}
        </span>
      )
    case 'error':
      return (
        <span className="ev-save" data-state="error">
          Not saved: {status.reason}
          {status.retrying ? ' — retrying' : local}
        </span>
      )
    case 'partial':
      return (
        <span className="ev-save" data-state="partial">
          Not saved: {status.reason}
          {local}
        </span>
      )
    case 'stopped':
      return (
        <span className="ev-save" data-state="error">
          Not saved: {status.reason}
        </span>
      )
    default:
      if (dirty && view)
        return (
          <span className="ev-save" data-state="saving">
            Saving…
          </span>
        )
      return (
        <span className="ev-save" data-state="saved">
          All changes saved ✓{status.kind === 'saved' ? ` ${formatIn(status.at, mode, 'time')}` : ''}
        </span>
      )
  }
}
