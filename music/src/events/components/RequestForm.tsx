'use client'

// The one-page request form (0.5.3), for a new request (/request) and for
// editing a draft (/my/events/:id): Details · Date & time · Visibility ·
// Songs · Announcements · Review & submit. It saves itself (autosave.ts):
// a local backup of the whole form at every change, the draft created on
// the server as soon as its minimum is valid, then debounced PATCH/PUT saves.
// Playlist rule problems never block a draft save (the API stores any
// structurally valid draft playlist); they are shown live and block Submit.
// Two tabs on one draft: each keeps its own device copy, and a newer server
// copy (a 409, the tab coming back into view, the other tab saving) is merged
// into the form (merge.ts) instead of being written over. A device copy left
// behind is restored on the next load (restore.ts), or asked about when it
// would overwrite newer work done elsewhere.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Notice } from '@/components/ui'
import {
  type Backup,
  backupKey,
  clearBackup,
  DraftSaver,
  isDraftBackupKey,
  movedMessage,
  payloadKey,
  readBackup,
  readDraftBackups,
  type SavePlan,
  type SaveStatus,
  tabBackupKey,
  writeBackup,
} from './autosave'
import { api, ApiError, evMessage } from './ev-api'
import { builderFromView, draftFromView, patchFor } from './fromView'
import { rulesList } from './HomeParts'
import { describeChanges, type FormState, listWords, mergeForm, mergeNote, restoreConflicts, undoRestore } from './merge'
import { backupForm, EMPTY_BUILDER, type FormData, formOfView, planRestore, rebaseForm, type RestorePlan } from './restore'
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

const newTabId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
/** How long after another tab's device copy changes this tab re-reads the draft. */
const STORAGE_REFRESH_MS = 800
/** How long a merge note stays up (it also goes at the next save without a merge). */
const NOTE_MS = 10_000
const NOT_SAVED_SUBMIT = "Your latest changes aren't saved yet, so the request was not sent. Check the save status above and try again."

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
  const [note, setNoteState] = useState<string | null>(null)
  /** "Use the saved version instead" is catching up with the server first. */
  const [undoBusy, setUndoBusy] = useState(false)
  /** What the restored device copy changed (named in the restore notice). */
  const [restoredWhat, setRestoredWhat] = useState<string[]>([])
  /** A device copy that would overwrite newer work: waiting for a choice. */
  const [ask, setAsk] = useState<RestorePlan | null>(null)
  const [tab] = useState(newTabId)
  const sources = useAudioSources()
  // The merge note clears after NOTE_MS, and at the next save that merged nothing.
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mergedThisSave = useRef(false)
  /** The note shown now (a merge during the same save adds to it). */
  const noteRef = useRef<string | null>(null)
  /** The form when the saver stopped (a later change is not saved: say so). */
  const stopKey = useRef<string | null>(null)
  const setNote = (n: string | null) => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = n
      ? setTimeout(() => {
          noteRef.current = null
          setNoteState(null)
        }, NOTE_MS)
      : null
    noteRef.current = n
    setNoteState(n)
  }
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current)
    },
    [],
  )

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
  // What plan(v) sends, as the form the server then holds (a keepalive
  // record): fields that are not valid yet, and a time that does not fit,
  // stay at the saved value.
  const sentData = (v: FullView): FormData => {
    const vd = draftFromView(v, zone)
    const d: Draft = {
      ...draft,
      title: detailErrors.title ? vd.title : draft.title,
      hostName: detailErrors.hostName ? vd.hostName : draft.hostName,
      location: detailErrors.location ? vd.location : draft.location,
      description: detailErrors.description ? vd.description : draft.description,
      eventType: draft.eventType || vd.eventType,
      visibility: draft.visibility || vd.visibility,
      ...(timeOk ? {} : { date: vd.date, time: vd.time, lengthMin: vd.lengthMin }),
    }
    return { draft: d, builder, startsAt: timeOk ? time.startsAt : v.startsAt, key: '' }
  }
  const sentRef = useRef(sentData)
  sentRef.current = sentData
  const formKeyRef = useRef(formKey)
  formKeyRef.current = formKey
  const synced = useRef<string>(formKey)
  const viewRef = useRef(view)
  viewRef.current = view
  // The latest form and what merging needs (read by adopt, outside render).
  const live = useRef({ draft, builder, zone, audio: sources.audio.length ? sources.audio : audio, stingers: sources.stingers.length ? sources.stingers : stingers })
  live.current = { draft, builder, zone, audio: sources.audio.length ? sources.audio : audio, stingers: sources.stingers.length ? sources.stingers : stingers }
  /** The server copy the form is relative to (saved in the device copy). */
  const baseRef = useRef<FullView | null>(initial ?? null)
  /** Other tabs' device copies merged into this form at load (dropped once saved). */
  const absorbed = useRef<string[]>([])
  /**
   * The last restore of device copies: the form before it and right after
   * it. "Use the saved version instead" undoes what it changed, even once
   * the restore has saved itself (the saved version is then the restored
   * one), but only where nothing changed since (merge.ts undoRestore).
   */
  const restoreUndo = useRef<{ before: FormState; after: FormState } | null>(null)
  const adopted = useRef<(() => void) | null>(null)
  const [adoptN, setAdoptN] = useState(0)
  useEffect(() => {
    adopted.current?.()
    adopted.current = null
  }, [adoptN])
  useEffect(
    () => () => {
      adopted.current?.()
      adopted.current = null
    },
    [],
  )

  const saver = useMemo(
    () =>
      new DraftSaver<FormData>({
        initial: initial ?? null,
        plan: (v) => planRef.current(v),
        snapshot: (v) => sentRef.current(v),
        onLedger: (ledger, v, sent) => {
          // What the server holds is not known until the answer comes back:
          // nothing counts as saved meanwhile (undoing the change while it is
          // in flight, or after its answer was lost, is then saved too).
          if (sent) synced.current = ''
          // The tab's device copy lists every save not answered yet, made
          // against the current base, so a reopened page can tell whether
          // they arrived (restore.ts) even if this page is killed now.
          const k = tabBackupKey(userKey, v.id, tab)
          const b = readBackup<FormData>(k)
          if (!b) return
          const saves = ledger.filter((r) => r.baseVersion >= v.version)
          writeBackup(k, { ...b, baseVersion: v.version, base: v, keepalive: saves.length ? saves : undefined })
        },
        onView: (v) => {
          const first = !viewRef.current
          viewRef.current = v
          baseRef.current = v
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
        adopt: (b, fresh, saves) =>
          new Promise<void | 'held'>((resolve) => {
            const { draft: d, builder: bl, zone: z, audio: au, stingers: st } = live.current
            const c = { zone: z, audio: au, stingers: st }
            // This tab's saves the fresh copy already holds (a keepalive sent
            // as the tab was hidden, a save whose answer was lost) are part
            // of the base: never merged again over newer work (restore.ts).
            const base = rebaseForm(formOfView(b, c), saves.landed, z)
            const local: FormState = { draft: d, builder: bl }
            const server = formOfView(fresh, c)
            const r = mergeForm(base, local, server)
            baseRef.current = fresh
            adopted.current?.()
            if (saves.unknown.length && r.local && restoreConflicts(base, local, server, true)) {
              // A save whose arrival cannot be told, and merging would
              // overwrite work done elsewhere: show the saved version and ask
              // (restore.ts does the same on a reopen). This tab's device copy
              // is kept aside meanwhile, so closing the tab loses nothing.
              const v = viewRef.current
              const keys: string[] = []
              if (v) {
                const own = readBackup<FormData>(tabBackupKey(userKey, v.id, tab))
                const aside = tabBackupKey(userKey, v.id, `${tab}-held`)
                if (own && own.baseVersion === b.version && writeBackup(aside, own)) keys.push(aside)
              }
              setAsk({ form: { draft: r.draft, builder: r.builder }, changed: true, ask: true, kept: r.kept, changes: describeChanges(server, r), keys })
              adopted.current = () => resolve('held')
              setDraft(server.draft)
              setBuilder(server.builder)
              setAdoptN((x) => x + 1)
              return
            }
            adopted.current = resolve
            setDraft(r.draft)
            setBuilder(r.builder)
            // Only what visibly came in from elsewhere (this tab's own
            // keepalive arriving changes nothing in the form: no note).
            const n = r.merged ? mergeNote(describeChanges({ draft: d, builder: bl }, r), r.kept) : null
            if (n) {
              // a note from this same save (what an undo kept, an earlier
              // merge) stays: this one is added to it
              const prev = mergedThisSave.current ? noteRef.current : null
              mergedThisSave.current = true
              setNote(prev && !prev.includes(n) ? `${prev} ${n}` : n)
            }
            setAdoptN((x) => x + 1)
          }),
        onStatus: (st) => {
          // The merge note stays until the next save that actually sent
          // something without merging (a check that finds everything saved
          // does not count), or NOTE_MS.
          if (st.kind === 'saved') {
            if (st.wrote && !mergedThisSave.current) setNote(null)
            mergedThisSave.current = false
            // a "not saved yet, so not sent" submit message is out of date now
            setSubmitErr((e) => (e === NOT_SAVED_SUBMIT ? null : e))
          }
          if (st.kind === 'stopped') stopKey.current = formKeyRef.current
          setStatus(st)
        },
        audioName: (id) => {
          const b = live.current.builder
          return b.tracks.find((t) => t.audioId === id)?.title ?? b.anns.find((a) => a.audioId === id)?.title ?? null
        },
        onSynced: (key) => {
          synced.current = key
          if (key === formKeyRef.current && viewRef.current) {
            clearBackup(tabBackupKey(userKey, viewRef.current.id, tab))
            for (const k of absorbed.current.splice(0)) clearBackup(k)
          }
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
    if (!initial) {
      const b = readBackup<FormData>(backupKey(userKey, 'new'))
      if (b && b.eventId === null && b.data.key !== synced.current) {
        const f = backupForm(b.data, zone)
        setDraft(f.draft)
        setBuilder(f.builder)
        setRestored(true)
      }
      return
    }
    // A draft: every tab's device copy is merged, oldest first, into the
    // server copy this page loaded (never written over it): a field changed
    // on the server since the copy was made stays unless the copy changed it,
    // and a keepalive save that arrived is not applied again (restore.ts).
    const found = readDraftBackups<FormData>(userKey, initial.id)
    if (!found.length) return
    const p = planRestore(initial, found, { zone, audio, stingers })
    if (!p.changed) {
      // everything in them is already saved
      for (const k of p.keys) clearBackup(k)
      return
    }
    if (p.ask) {
      // It would overwrite newer work done elsewhere: nothing is sent until
      // the member chooses (the copies stay until then).
      saver.hold()
      setAsk(p)
      return
    }
    absorbed.current.push(...p.keys)
    restoreUndo.current = { before: formOfView(initial, { zone, audio, stingers }), after: p.form }
    setDraft(p.form.draft)
    setBuilder(p.form.builder)
    setRestored(true)
    setRestoredWhat(p.changes)
    if (p.kept.length) setNote(`The saved copy had also changed since; this device's ${listWords(p.kept)} ${p.kept.length > 1 ? 'were' : 'was'} kept.`)
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Every change: back it up on this device, then (debounced) to the server.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const k = view ? tabBackupKey(userKey, view.id, tab) : backupKey(userKey, 'new')
    if (formKey === synced.current) {
      clearBackup(k)
      for (const a of absorbed.current.splice(0)) clearBackup(a)
      return
    }
    const base = view ? baseRef.current : null
    // The saves not answered yet, relative to this base (see onLedger).
    const pending = base ? saver.unanswered.filter((r) => r.baseVersion >= base.version) : []
    const keepalive = pending.length ? [...pending] : undefined
    const b: Backup<FormData> = {
      v: 2,
      savedAt: Date.now(),
      eventId: view?.id ?? null,
      baseVersion: base?.version ?? null,
      base,
      data: { draft, builder, startsAt: time.startsAt, key: formKey },
      ...(keepalive ? { keepalive } : {}),
    }
    setStorageOk(writeBackup(k, b))
    saver.touch()
    // formKey covers draft + builder; a new base (a save, a merge) is re-recorded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey, view?.id, view?.version])

  // Leaving or hiding the page: send the last changes with keepalive.
  const dirtyRef = useRef(false)
  dirtyRef.current = formKey !== synced.current
  // Back in view, or another tab saved (its device copy changed): catch up
  // with the server so this tab shows the other tab's work and never later
  // sends an old copy over it.
  useEffect(() => {
    saver.revive()
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const refreshSoon = (ms: number) => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void saver.refresh()
      }, ms)
    }
    // Closing a tab fires both visibilitychange and pagehide: send each form
    // state once per base version.
    let lastSent = ''
    const flush = () => {
      if (!dirtyRef.current) return
      const v = saver.view
      const once = v ? `${v.version}|${formKeyRef.current}` : ''
      if (once && once === lastSent) return
      // The saver records what it sent in its ledger and (onLedger) in this
      // tab's device copy: a reopened page, or this tab coming back, can then
      // tell whether it arrived (the event's recentSaveIds).
      saver.flushKeepalive()
      lastSent = once
    }
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush()
      else refreshSoon(50)
    }
    const onFocus = () => refreshSoon(50)
    const onStorage = (e: StorageEvent) => {
      const v = viewRef.current
      if (v && e.key && isDraftBackupKey(e.key, userKey, v.id) && e.key !== tabBackupKey(userKey, v.id, tab)) refreshSoon(STORAGE_REFRESH_MS)
    }
    const onOnline = () => void saver.kick()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flush)
    window.addEventListener('focus', onFocus)
    window.addEventListener('storage', onStorage)
    window.addEventListener('online', onOnline)
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('online', onOnline)
      flush()
      saver.stop()
    }
  }, [saver, userKey, tab])

  // An upload the form waits for may have become usable: retry now.
  useEffect(() => saver.nudge(), [saver, sources.audio])

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

  /** Every tab's device copy of the draft (it was sent, discarded or reset). */
  const clearDraftBackups = (id: number) => {
    for (const { key } of readDraftBackups(userKey, id)) clearBackup(key)
    clearBackup(tabBackupKey(userKey, id, tab))
    absorbed.current = []
  }

  const revertToSaved = async () => {
    if (!initial) {
      // a new request: start over with an empty form
      clearBackup(backupKey(userKey, 'new'))
      setResetN((n) => n + 1)
      setDraft(EMPTY_DRAFT)
      setBuilder(EMPTY_BUILDER)
      setRestored(false)
      return
    }
    if (restoreUndo.current) {
      if (undoBusy) return
      // First catch up with the server: what another device changed since
      // the restore is then in the form, and stays (this tab may not have
      // looked since: no focus / visibility change, no 409).
      setUndoBusy(true)
      const noteBefore = noteRef.current
      const ok = await saver.catchUpNow()
      setUndoBusy(false)
      // what the catch-up merged in (its note stays, the undo's is added)
      const caught = noteRef.current !== noteBefore ? noteRef.current : null
      const u = restoreUndo.current
      if (!u) return
      if (!ok) {
        // offline, or a question about a device copy is up: nothing undone
        if (!saver.isHeld) setNote("Couldn't check the saved version for newer changes, so nothing was undone. Try again in a moment.")
        return
      }
      restoreUndo.current = null
      // Undo what the restore changed (it may have saved itself already)
      // where the form still holds what the restore put there; whatever
      // changed since (another device, or typed after the restore) stays.
      // The result saves like any edit. (The form as it is after the catch-up.)
      const { draft: d, builder: bl } = live.current
      const r = undoRestore(u.before, u.after, { draft: d, builder: bl })
      for (const k of absorbed.current.splice(0)) clearBackup(k)
      setRestoredWhat([])
      setDraft(r.draft)
      setBuilder(r.builder)
      setRestored(false)
      if (r.kept.length) {
        // stays up through the save of the undo
        mergedThisSave.current = true
        const kept = `Kept ${listWords(r.kept)} as ${r.kept.length > 1 ? 'they are' : 'it is'} now, because ${r.kept.length > 1 ? 'they' : 'it'} changed after the restore.`
        setNote(caught ? `${caught} ${kept}` : kept)
      } else {
        mergedThisSave.current = !!caught
        setNote(caught)
      }
      return
    }
    const v = viewRef.current ?? initial
    clearDraftBackups(v.id)
    setResetN((n) => n + 1)
    setNote(null)
    setRestoredWhat([])
    setDraft(draftFromView(v, zone))
    setBuilder(builderFromView(v, sources.audio.length ? sources.audio : audio, sources.stingers.length ? sources.stingers : stingers))
    setRestored(false)
  }

  // The member's choice about a device copy that would overwrite newer work.
  const answerRestore = (restore: boolean) => {
    const p = ask
    if (!p) return
    setAsk(null)
    if (restore) {
      // Edits made while the question was up stay, on top of the restore.
      const now: FormState = { draft, builder }
      const server = formOfView(viewRef.current ?? initial!, { zone, audio: live.current.audio, stingers: live.current.stingers })
      const r = mergeForm(server, now, p.form)
      absorbed.current.push(...p.keys)
      restoreUndo.current = { before: now, after: { draft: r.draft, builder: r.builder } }
      setDraft(r.draft)
      setBuilder(r.builder)
      setRestored(true)
      setRestoredWhat(p.changes)
    } else {
      for (const k of p.keys) clearBackup(k)
    }
    saver.release()
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
        setSubmitErr(NOT_SAVED_SUBMIT)
        return
      }
      const r = await api<{ event: FullView }>(`/api/ev/events/${v.id}/submit`, { json: {} })
      saver.stop()
      clearDraftBackups(v.id)
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
      // expectStatus: never withdraw a request submitted meanwhile elsewhere
      await api(`/api/ev/events/${v.id}/withdraw`, { json: { expectStatus: 'draft' } })
      clearDraftBackups(v.id)
      window.location.assign('/my')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'status_changed') {
        const st = typeof e.body?.status === 'string' ? e.body.status : undefined
        setStatus({ kind: 'stopped', reason: `${movedMessage(st, formKey !== synced.current)} It was not discarded here.`, reloadHref: `/my/events/${v.id}` })
      } else {
        saver.revive()
        setSubmitErr(evMessage(e))
      }
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

  // Stopped because the request left the draft state elsewhere, and the
  // form changed since: those changes are not saved either.
  const shownStatus: SaveStatus =
    status.kind === 'stopped' && status.moved !== undefined && formKey !== stopKey.current ? { ...status, reason: movedMessage(status.moved || undefined, true) } : status
  // "Use the saved version instead" only while the restore left something to undo.
  const undo = restoreUndo.current
  const undoable = !!undo && undoRestore(undo.before, undo.after, { draft, builder }).undone.length > 0
  const statusView = <SaveStatusText status={shownStatus} view={view} missing={missing} dirty={formKey !== synced.current} storageOk={storageOk} mode={mode} />
  const run = runningLength(builder.tracks)
  // Uploads that failed their check (My audio, or the server's refusal): marked in the lists.
  const failedAudio = new Set<number>(sources.audio.filter((a) => a.status === 'failed' || a.status === 'rejected').map((a) => a.id))
  if (status.kind === 'error' && status.audioId !== undefined) failedAudio.add(status.audioId)
  const editors = { value: builder, onChange: setBuilder, start: time.startsAt, end: time.endsAt, sources, uploadsEnabled: config.uploadsEnabled, chunkBytes, failedAudio }

  return (
    <div className="space-y-5">
      <div className="ev-savebar card" data-testid="rf-status-top">
        <p className="text-sm" aria-live="polite" role="status">
          {statusView}
          {note ? (
            <span className="block text-xs text-cream/75" data-testid="rf-merge-note">
              {note}
            </span>
          ) : null}
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
      {ask ? (
        <Notice tone="warn">
          <div className="space-y-2" data-testid="rf-restore-ask">
            <p>
              This device has changes to this request that weren&apos;t saved, but the request was changed somewhere else since (another tab or device). Restoring them
              would change:
            </p>
            <ul className="list-disc space-y-1 pl-4">
              {(ask.changes.length ? ask.changes : ['the saved request']).map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p>Nothing is saved until you choose.</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => answerRestore(true)}>
                Restore these changes
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => answerRestore(false)}>
                Keep the saved version
              </button>
            </div>
          </div>
        </Notice>
      ) : null}
      {restored ? (
        <Notice tone="info">
          We restored changes you made on this device that hadn&apos;t been saved yet{restoredWhat.length ? `: ${listWords(restoredWhat)}` : ''}. They save automatically now.
          {(initial ? undoable : !view) ? (
            <>
              {' '}
              <button type="button" className="link" onClick={() => void revertToSaved()} disabled={undoBusy}>
                {initial ? (undoBusy ? 'Checking the saved version…' : 'Use the saved version instead') : 'Start over'}
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
          {status.reloadHref ? status.reason : `Not saved: ${status.reason}`}
          {status.reloadHref ? (
            <>
              {' '}
              <a className="link" href={status.reloadHref}>
                Reload the request
              </a>
            </>
          ) : null}
        </span>
      )
    case 'held':
      return (
        <span className="ev-save" data-state="partial">
          Not saving yet: choose what to do with the changes kept on this device (above).
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
