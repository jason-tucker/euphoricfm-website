'use client'

// Owner (and staff) editing of one event: status + ticket, details, time,
// visibility, playlist, submit / withdraw. Explains re-approval when an
// approved event is edited, and locks everything at the freeze time (for
// members; staff may edit until the end). Every save sends the loaded
// `version`: a 409 version_conflict reloads the event and says why. A change
// to a LIVE event that the server answers with 409 restart_required opens a
// staff confirmation, and only then is it re-sent with confirmRestart.

import { useEffect, useMemo, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useJson } from '@/components/hooks'
import { Notice } from '@/components/ui'
import type { EventTrack } from '@/events/contract/types'
import { api, evMessage, isRestartRequired, isVersionConflict } from './ev-api'
import { StatusChip } from './EventViewCard'
import { useEvConfig, useNow } from './hooks'
import { EVENT_TYPE_LABEL, statusOf } from './labels'
import { newKey, PlaylistBuilder, recallTitle } from './PlaylistBuilder'
import { type BAnn, type BTrack, type Builder, builderProblems, toPayload } from './playlist'
import { DetailsFields, TimeFields, toInputs, useAvailability, VisibilityFields } from './RequestParts'
import { MIN } from './time'
import { type AudioItem, type FullView, listOf, type Stinger } from './types'
import { useTz, When } from './tz'
import { checkDetails, checkTime, type Draft, enteredTz, withoutSelf } from './wizard'

const RE_APPROVAL_STATUSES = new Set(['approved', 'built'])
const WITHDRAWABLE = new Set(['draft', 'pending', 'approved', 'built'])

export function builderFromView(v: FullView, audio: AudioItem[], stingers: Stinger[]): Builder {
  const tracks: BTrack[] = [...v.tracks]
    .sort((a: EventTrack, b: EventTrack) => a.position - b.position)
    .map((t) => {
      if (t.source === 'upload') {
        const a = audio.find((x) => x.id === t.audioId)
        return { key: newKey(), source: 'upload', mediaId: null, audioId: t.audioId, title: a?.title ?? `Upload #${t.audioId}`, artist: a?.artist ?? null, lengthS: a?.durationS ?? null, pinAt: t.pinAt }
      }
      const r = t.mediaId ? recallTitle(t.mediaId) : null
      return { key: newKey(), source: 'library', mediaId: t.mediaId, audioId: null, title: r?.title ?? `Library song #${t.mediaId}`, artist: r?.artist ?? null, lengthS: r?.lengthS ?? null, pinAt: t.pinAt }
    })
  const anns: BAnn[] = v.announcements.map((a) => {
    const st = a.source === 'stinger' ? stingers.find((s) => s.mediaId === a.mediaId) : null
    const up = a.source === 'upload' ? audio.find((x) => x.id === a.audioId) : null
    return {
      key: newKey(),
      source: a.source,
      mediaId: a.mediaId,
      audioId: a.audioId,
      title: st?.title ?? up?.title ?? (a.source === 'stinger' ? `Announcement #${a.mediaId}` : `Upload #${a.audioId}`),
      lengthS: st?.lengthS ?? up?.durationS ?? null,
      mode: a.mode,
      at: a.at,
      everyMin: a.everyMin,
      from: a.from,
      until: a.until,
    }
  })
  return { tracks, anns, order: v.playlistOrder }
}

function draftFromView(v: FullView, zone: string | undefined): Draft {
  const s = toInputs(v.startsAt, zone)
  return {
    title: v.title,
    hostName: v.hostName ?? '',
    description: v.description ?? '',
    location: v.location ?? '',
    eventType: v.eventType,
    date: s.date,
    time: s.time,
    lengthMin: Math.round((Date.parse(v.endsAt) - Date.parse(v.startsAt)) / MIN),
    visibility: v.visibility,
  }
}

/** The PATCH body: only fields that changed. */
export function patchFor(v: FullView, d: Draft, startsAt: string | null, endsAt: string | null, tz: string): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  const nul = (s: string) => (s.trim() ? s.trim() : null)
  if (d.title.trim() !== v.title) p.title = d.title.trim()
  if (nul(d.hostName) !== v.hostName) p.hostName = nul(d.hostName)
  if (nul(d.description) !== v.description) p.description = nul(d.description)
  if (nul(d.location) !== v.location) p.location = nul(d.location)
  if (d.eventType && d.eventType !== v.eventType) p.eventType = d.eventType
  if (d.visibility && d.visibility !== v.visibility) p.visibility = d.visibility
  if (startsAt && endsAt && (Date.parse(startsAt) !== Date.parse(v.startsAt) || Date.parse(endsAt) !== Date.parse(v.endsAt))) {
    p.startsAt = startsAt
    p.endsAt = endsAt
    p.enteredTz = tz
  }
  return p
}

/** Does a patch touch anything that needs re-approval (time, visibility)? */
export const patchNeedsReapproval = (p: Record<string, unknown>) => 'startsAt' in p || 'visibility' in p

export function EventEditor({ id, staff, viewerDiscordId }: { id: number; staff: boolean; viewerDiscordId: string }) {
  const [reload, setReload] = useState(0)
  const ev = useJson<FullView>(`/api/ev/events/${id}?r=${reload}`)
  const audio = useJson<unknown>('/api/ev/audio')
  const stingers = useJson<unknown>('/api/ev/stingers')
  const [view, setView] = useState<FullView | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  useEffect(() => {
    if (ev.data) setView(ev.data)
  }, [ev.data])
  if (ev.error) return <Notice tone="error">This event doesn&apos;t exist, or you don&apos;t have access to it.</Notice>
  if (!view || (!audio.data && audio.loading) || (!stingers.data && stingers.loading)) return <p className="text-sm text-cream/60">Loading…</p>
  if (view.kind !== 'full') return <Notice tone="error">You can only change your own events.</Notice>
  return (
    <EditorBody
      key={`${view.id}-${reload}`}
      view={view}
      staff={staff}
      own={view.ownerDiscordId === viewerDiscordId}
      audio={listOf<AudioItem>(audio.data)}
      stingers={listOf<Stinger>(stingers.data)}
      flash={flash}
      onChanged={(v) => {
        setFlash(null)
        if (v) setView(v)
        else setReload((n) => n + 1)
      }}
      onConflict={(text) => {
        setFlash(text)
        setReload((n) => n + 1)
      }}
    />
  )
}

function EditorBody({
  view,
  staff,
  own,
  audio,
  stingers,
  flash,
  onChanged,
  onConflict,
}: {
  view: FullView
  staff: boolean
  own: boolean
  audio: AudioItem[]
  stingers: Stinger[]
  flash: string | null
  onChanged: (v: FullView | null) => void
  onConflict: (text: string) => void
}) {
  const { config } = useEvConfig()
  const { mode, zone } = useTz()
  const now = useNow(30_000)
  const [draft, setDraft] = useState<Draft>(() => draftFromView(view, zone))
  const [builder, setBuilder] = useState<Builder>(() => builderFromView(view, audio, stingers))
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(() => (flash ? { tone: 'error', text: flash } : null))
  const [confirm, setConfirm] = useState<null | 'withdraw' | 'details' | 'playlist'>(null)
  // A live-event save the server refused with restart_required, waiting for
  // the staff member to confirm the station restart.
  const [restart, setRestart] = useState<null | 'details' | 'playlist'>(null)

  // Re-split the inputs when the viewer flips the zone toggle.
  useEffect(() => {
    setDraft((d) => ({ ...d, ...toInputs(view.startsAt, zone) }))
  }, [zone, view.startsAt])

  const avail = useAvailability(draft.date, true)
  const time = checkTime({ when: draft, mode, now, config, staff, busy: withoutSelf(avail.busy, view) })
  const detailErrors = checkDetails(draft)
  const problems = useMemo(() => (time.startsAt && time.endsAt ? builderProblems(builder, time.startsAt, time.endsAt, config.maxRows) : []), [builder, time.startsAt, time.endsAt, config.maxRows])

  // The server's canEdit already applies the freeze to members; staff may
  // keep editing (a live event needs the restart confirmation below).
  const frozen = !view.canEdit || (!staff && now >= Date.parse(view.freezeAt))
  const reapproval = RE_APPROVAL_STATUSES.has(view.status) && !staff
  const st = statusOf(view.status)
  const patch = patchFor(view, draft, time.startsAt, time.endsAt, enteredTz(mode))
  // An unchanged time must not be re-checked against the notice rules.
  const timeChanged = 'startsAt' in patch
  const timeBlocking = timeChanged && time.errors.length > 0

  const run = async (label: string, fn: () => Promise<FullView | null>, okText: string) => {
    setBusy(label)
    setMsg(null)
    try {
      const v = await fn()
      setMsg({ tone: 'ok', text: okText })
      onChanged(v)
    } catch (e) {
      if (isVersionConflict(e)) onConflict(evMessage(e))
      else if (staff && isRestartRequired(e) && (label === 'details' || label === 'playlist')) setRestart(label)
      else setMsg({ tone: 'error', text: evMessage(e) })
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  // confirmRestart is only ever sent from the restart confirmation dialog.
  const guard = (confirmRestart: boolean) => ({ version: view.version, ...(confirmRestart ? { confirmRestart: true } : {}) })
  const saveDetails = (confirmRestart = false) =>
    run('details', async () => (await api<{ event: FullView }>(`/api/ev/events/${view.id}`, { method: 'PATCH', json: { ...patch, ...guard(confirmRestart) } })).event, 'Saved.')
  const savePlaylist = (confirmRestart = false) =>
    run(
      'playlist',
      async () => (await api<{ event: FullView }>(`/api/ev/events/${view.id}/playlist`, { method: 'PUT', json: { ...toPayload(builder), ...guard(confirmRestart) } })).event,
      'Playlist saved.',
    )
  const submit = () =>
    run(
      'submit',
      async () => {
        await api(`/api/ev/events/${view.id}/playlist`, { method: 'PUT', json: { ...toPayload(builder), ...guard(false) } })
        return (await api<{ event: FullView }>(`/api/ev/events/${view.id}/submit`, { json: {} })).event
      },
      'Submitted. A ticket opens in the EuphoricFM Discord in a minute or two.',
    )
  const withdraw = () => run('withdraw', async () => (await api<{ event: FullView }>(`/api/ev/events/${view.id}/withdraw`, { json: {} })).event, 'Withdrawn.')

  return (
    <div className="space-y-6">
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={view.status} />
          <span className="ev-tag">{view.visibility === 'private' ? 'Private' : 'Public'}</span>
          <span className="ev-tag">{EVENT_TYPE_LABEL[view.eventType]}</span>
          {view.shortNotice ? <span className="chip chip-pending">Short notice</span> : null}
          {!own && staff ? <span className="chip chip-staff">Staff view</span> : null}
        </div>
        <h1 className="text-2xl font-bold text-cream">{view.title}</h1>
        <p className="text-cream/85">
          <When at={view.startsAt} end={view.endsAt} />
        </p>
        <p className="text-sm text-cream/70">{st.help}</p>
        <div className="flex flex-wrap gap-3">
          {view.ticketUrl ? (
            <a className="btn btn-discord" href={view.ticketUrl} target="_blank" rel="noopener noreferrer">
              Open the ticket ↗
            </a>
          ) : view.status !== 'draft' ? (
            <span className="text-xs text-cream/60">The Discord ticket appears here once it has opened.</span>
          ) : null}
          {view.status !== 'draft' ? (
            <a className="btn btn-secondary" href={`/events/${view.id}`}>
              View on the calendar
            </a>
          ) : null}
        </div>
        {frozen ? (
          <Notice tone="info">
            Changes are locked from <When at={view.freezeAt} format="short" /> ({config.freezeMin} minutes before the start). Need something changed? Ask in your ticket.
          </Notice>
        ) : reapproval ? (
          <Notice tone="warn">
            This event is approved. Changing its songs, announcements, time or visibility sends it back to Pending for a quick re-approval (your slot stays held, and the
            ticket gets the list of changes). Changing only the description or host does not.
          </Notice>
        ) : null}
        {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      </section>

      {frozen ? null : (
        <>
          <section className="card space-y-5" aria-labelledby="ed-details">
            <h2 id="ed-details" className="text-lg font-bold text-cream">
              Details and time
            </h2>
            <DetailsFields value={draft} onChange={(d) => setDraft({ ...draft, ...d })} errors={detailErrors} showErrors />
            <TimeFields
              value={draft}
              onChange={(w) => setDraft({ ...draft, ...w })}
              check={timeChanged ? time : { ...time, errors: [], warnings: time.warnings.filter((w) => !w.startsWith('Short notice')) }}
              busy={withoutSelf(avail.busy, view)}
              busyLoading={avail.loading}
              busyError={avail.error}
              maxHours={staff ? 72 : config.memberMaxHours}
              showErrors
            />
            <VisibilityFields value={draft.visibility} onChange={(v) => setDraft({ ...draft, visibility: v })} showErrors />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!busy || Object.keys(patch).length === 0 || Object.keys(detailErrors).length > 0 || timeBlocking}
              onClick={() => (reapproval && patchNeedsReapproval(patch) ? setConfirm('details') : void saveDetails())}
            >
              {busy === 'details' ? 'Saving…' : Object.keys(patch).length ? 'Save changes' : 'No changes to save'}
            </button>
          </section>

          <section className="card space-y-5" aria-labelledby="ed-playlist">
            <h2 id="ed-playlist" className="text-lg font-bold text-cream">
              Playlist
            </h2>
            <PlaylistBuilder value={builder} onChange={setBuilder} start={view.startsAt} end={view.endsAt} maxRows={config.maxRows} uploadsEnabled={config.uploadsEnabled} />
            {problems.length ? (
              <Notice tone="warn">
                <ul className="list-disc space-y-1 pl-4">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => (reapproval ? setConfirm('playlist') : void savePlaylist())}>
                {busy === 'playlist' ? 'Saving…' : 'Save playlist'}
              </button>
              {view.status === 'draft' && own ? (
                <button type="button" className="btn btn-primary" disabled={!!busy || problems.length > 0 || timeBlocking} onClick={() => void submit()}>
                  {busy === 'submit' ? 'Submitting…' : 'Submit request'}
                </button>
              ) : null}
            </div>
            {'startsAt' in patch ? <p className="text-xs text-cream/60">Save the new time first: the playlist is checked against the saved time.</p> : null}
          </section>
        </>
      )}

      {own && WITHDRAWABLE.has(view.status) ? (
        <section className="card space-y-2">
          <h2 className="text-lg font-bold text-cream">{view.status === 'draft' ? 'Discard this draft' : 'Withdraw this request'}</h2>
          <p className="text-sm text-cream/75">This frees the time slot. It can&apos;t be undone.</p>
          <button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => setConfirm('withdraw')}>
            {view.status === 'draft' ? 'Discard draft' : 'Withdraw'}
          </button>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirm === 'withdraw'}
        title={view.status === 'draft' ? 'Discard this draft?' : 'Withdraw this request?'}
        confirmLabel={view.status === 'draft' ? 'Discard' : 'Withdraw'}
        confirmClass="btn-danger"
        busy={busy === 'withdraw'}
        onConfirm={() => void withdraw()}
        onCancel={() => setConfirm(null)}
      >
        <p>&quot;{view.title}&quot; will be taken off the calendar and the time slot freed. The ticket is told and closed.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'details' || confirm === 'playlist'}
        title="Send it back for re-approval?"
        confirmLabel="Save and send for re-approval"
        busy={busy === 'details' || busy === 'playlist'}
        onConfirm={() => void (confirm === 'details' ? saveDetails() : savePlaylist())}
        onCancel={() => setConfirm(null)}
      >
        <p>This event is approved. Saving this change puts it back to Pending until the team approves it again. Your slot stays held.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={restart !== null}
        title="Restart the Event station?"
        confirmLabel="Restart and save"
        confirmClass="btn-danger"
        busy={busy === 'details' || busy === 'playlist'}
        onConfirm={() => {
          const what = restart
          setRestart(null)
          void (what === 'details' ? saveDetails(true) : savePlaylist(true))
        }}
        onCancel={() => setRestart(null)}
      >
        <p>
          &quot;{view.title}&quot; is on air. This change restarts the Event station and cuts the current song; the new schedule is checked again after the restart.
        </p>
      </ConfirmDialog>
    </div>
  )
}
