'use client'

// Staff tools: review queue, decision panel (approve / deny with reason /
// cancel with reason / visibility / build now), direct booking and the
// events settings form.

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useJson } from '@/components/hooks'
import { Notice } from '@/components/ui'
import { REASON_MAX } from '@/events/contract/rules'
import { ANNOUNCE_STRATEGIES, EVENTS_SETTING_DEFAULTS, EVENTS_SETTING_KEYS, type EventsSettingKey, type EventsSettings, PIN_STRATEGIES } from '@/events/contract/settings'
import { api, evMessage, isVersionConflict } from './ev-api'
import { StatusChip } from './EventViewCard'
import { useEvConfig, useNow } from './hooks'
import { DetailsFields, TimeFields, useAvailability, VisibilityFields } from './RequestParts'
import type { FullView, StaffQueue } from './types'
import { useTz, When } from './tz'
import { checkDetails, checkTime, type Draft, EMPTY_DRAFT, enteredTz } from './wizard'

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "user0001 (Discord 7000…)" — the name when the view carries one, the snowflake as secondary text. */
function Requester({ v }: { v: FullView }) {
  if (!v.ownerName) return <>Discord user {v.ownerDiscordId}</>
  return (
    <>
      {v.ownerName} <span className="text-cream/45">(Discord {v.ownerDiscordId})</span>
    </>
  )
}

function QueueRow({ v }: { v: FullView }) {
  return (
    <a href={`/staff/events/${v.id}`} className="row-link">
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-semibold text-cream">{v.title}</span>
          <StatusChip status={v.status} />
          {v.visibility === 'private' ? <span className="ev-tag">Private</span> : null}
          {v.shortNotice ? <span className="chip chip-pending">Short notice</span> : null}
        </span>
        <span className="block text-sm text-cream/75">
          <When at={v.startsAt} end={v.endsAt} />
        </span>
        <span className="block text-xs text-cream/55">
          Requested by <Requester v={v} /> · {count(v.tracks.length, 'song', 'songs')} · {count(v.announcements.length, 'announcement', 'announcements')}
        </span>
      </span>
    </a>
  )
}

export function StaffQueueView({ manage }: { manage: boolean }) {
  const { data, error, loading } = useJson<StaffQueue>('/api/ev/staff/queue')
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-2">
        <a className="btn btn-primary" href="/staff/book">
          Book an event directly
        </a>
        {manage ? (
          <a className="btn btn-secondary" href="/staff/settings">
            Events settings
          </a>
        ) : null}
      </div>
      {error ? <Notice tone="error">Couldn&apos;t load the queue. Try again in a minute.</Notice> : null}
      {loading || !data ? (
        error ? null : <p className="text-sm text-cream/60">Loading…</p>
      ) : (
        <>
          <section className="space-y-2" aria-label="Waiting for review">
            <h2 className="text-lg font-bold text-cream">Waiting for review ({data.pending.length})</h2>
            {data.pending.length ? (
              <ul className="space-y-2">
                {[...data.pending]
                  .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
                  .map((v) => (
                    <li key={v.id}>
                      <QueueRow v={v} />
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-sm text-cream/60">Nothing waiting. </p>
            )}
          </section>
          <section className="space-y-2" aria-label="Upcoming">
            <h2 className="text-lg font-bold text-cream">Upcoming ({data.upcoming.length})</h2>
            {data.upcoming.length ? (
              <ul className="space-y-2">
                {[...data.upcoming]
                  .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
                  .map((v) => (
                    <li key={v.id}>
                      <QueueRow v={v} />
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-sm text-cream/60">No approved events coming up.</p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

type Action = 'approve' | 'deny' | 'cancel' | 'build-now' | 'visibility'

export function StaffDecision({ id, manage }: { id: number; manage: boolean }) {
  const router = useRouter()
  const [reload, setReload] = useState(0)
  const { data: view, error } = useJson<FullView>(`/api/ev/events/${id}?s=${reload}`)
  const { config } = useEvConfig()
  const [open, setOpen] = useState<Action | null>(null)
  const [reason, setReason] = useState('')
  const [reasonErr, setReasonErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  if (error) return <Notice tone="error">This event doesn&apos;t exist.</Notice>
  if (!view) return <p className="text-sm text-cream/60">Loading…</p>
  if (view.kind !== 'full') return <Notice tone="error">The server did not return the staff view of this event.</Notice>

  const act = async (a: Action) => {
    if ((a === 'deny' || a === 'cancel') && !reason.trim()) {
      setReasonErr('A reason is required. It is posted to the ticket.')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      if (a === 'visibility') await api(`/api/ev/events/${id}`, { method: 'PATCH', json: { visibility: view.visibility === 'public' ? 'private' : 'public', version: view.version } })
      else if (a === 'deny' || a === 'cancel') await api(`/api/ev/events/${id}/${a}`, { json: { reason: reason.trim() } })
      else await api(`/api/ev/events/${id}/${a}`, { json: {} })
      setMsg({ tone: 'ok', text: a === 'approve' ? 'Approved.' : a === 'deny' ? 'Declined.' : a === 'cancel' ? 'Cancelled.' : a === 'build-now' ? 'Build queued.' : 'Visibility changed.' })
      setOpen(null)
      setReason('')
      setReload((n) => n + 1)
      router.refresh()
    } catch (e) {
      setMsg({ tone: 'error', text: evMessage(e) })
      setOpen(null)
      // The event changed under us: show the latest version.
      if (isVersionConflict(e)) setReload((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }

  const canDecide = view.status === 'pending'
  const canCancel = ['approved', 'built', 'live'].includes(view.status)
  return (
    <section className="card space-y-4" aria-labelledby="sd-h">
      <h2 id="sd-h" className="text-lg font-bold text-cream">
        Staff decision
      </h2>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <StatusChip status={view.status} />
        </dd>
        <dt>Requested by</dt>
        <dd>
          <Requester v={view} />
        </dd>
        <dt>Build</dt>
        <dd>{view.buildStatus ?? 'Not built'}</dd>
        <dt>Autobuild</dt>
        <dd>{config.autobuildEnabled ? 'On: approving queues the build' : 'Off: build by hand with "Build now"'}</dd>
      </dl>
      {view.ticketUrl ? (
        <a className="btn btn-discord" href={view.ticketUrl} target="_blank" rel="noopener noreferrer">
          Open the ticket ↗
        </a>
      ) : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <div className="flex flex-wrap gap-3">
        {canDecide ? (
          <>
            <button type="button" className="btn btn-approve" disabled={busy} onClick={() => setOpen('approve')}>
              Approve
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setOpen('deny')}>
              Deny…
            </button>
          </>
        ) : null}
        {canCancel ? (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setOpen('cancel')}>
            Cancel event…
          </button>
        ) : null}
        {!['ended', 'denied', 'withdrawn', 'cancelled', 'expired'].includes(view.status) ? (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setOpen('visibility')}>
            Make {view.visibility === 'public' ? 'private' : 'public'}
          </button>
        ) : null}
        {manage && ['approved', 'built', 'failed'].includes(view.status) ? (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setOpen('build-now')}>
            Build now
          </button>
        ) : null}
      </div>

      <ConfirmDialog open={open === 'approve'} title="Approve this event?" confirmLabel="Approve" confirmClass="btn-approve" busy={busy} onConfirm={() => void act('approve')} onCancel={() => setOpen(null)}>
        <p>
          &quot;{view.title}&quot;, <When at={view.startsAt} end={view.endsAt} />. The ticket is told.
          {config.autobuildEnabled ? ' The build is queued automatically.' : ' Autobuild is off, so build it with "Build now" when ready.'}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={open === 'deny' || open === 'cancel'}
        title={open === 'deny' ? 'Deny this request?' : 'Cancel this event?'}
        confirmLabel={open === 'deny' ? 'Confirm deny' : 'Confirm cancel'}
        confirmClass="btn-danger"
        busy={busy}
        onConfirm={() => void act(open === 'deny' ? 'deny' : 'cancel')}
        onCancel={() => {
          setOpen(null)
          setReasonErr(null)
        }}
      >
        <label htmlFor="sd-reason" className="label">
          Reason (posted to the ticket)
        </label>
        <textarea
          id="sd-reason"
          className="input min-h-[6rem]"
          maxLength={REASON_MAX}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value)
            setReasonErr(null)
          }}
        />
        {reasonErr ? (
          <p className="text-xs text-rose-300" role="alert">
            {reasonErr}
          </p>
        ) : null}
        {open === 'cancel' && view.status === 'live' ? <p className="text-rose-200">This event is on air. Cancelling stops it and restarts the Event station.</p> : null}
      </ConfirmDialog>
      <ConfirmDialog open={open === 'visibility'} title={`Make this event ${view.visibility === 'public' ? 'private' : 'public'}?`} confirmLabel="Change visibility" busy={busy} onConfirm={() => void act('visibility')} onCancel={() => setOpen(null)}>
        <p>{view.visibility === 'public' ? 'The calendar will show only "Booked · Private event" and the time.' : 'The calendar will show the title, host, place and description.'}</p>
      </ConfirmDialog>
      <ConfirmDialog open={open === 'build-now'} title="Build this event now?" confirmLabel="Build now" busy={busy} onConfirm={() => void act('build-now')} onCancel={() => setOpen(null)}>
        <p>This writes the event&apos;s playlists and schedule to the Event station now, even while autobuild is off.</p>
      </ConfirmDialog>
    </section>
  )
}

export function StaffBook() {
  const { config } = useEvConfig()
  const { mode } = useTz()
  const now = useNow(30_000)
  const [draft, setDraft] = useState<Draft>({ ...EMPTY_DRAFT, visibility: 'private' })
  const [owner, setOwner] = useState('')
  const [openTicket, setOpenTicket] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const avail = useAvailability(draft.date, true)
  const time = checkTime({ when: draft, mode, now, config, staff: true, busy: avail.busy })
  const detailErrors = checkDetails(draft)
  const ownerErr = owner.trim() && !/^\d{17,20}$/.test(owner.trim()) ? 'A Discord user id is 17–20 digits.' : null

  const book = async () => {
    setErr(null)
    if (Object.keys(detailErrors).length || time.errors.length || !time.startsAt || !time.endsAt || ownerErr || !draft.visibility) {
      setShowErrors(true)
      return
    }
    setBusy(true)
    try {
      const r = await api<{ event: FullView }>('/api/ev/staff/book', {
        json: {
          title: draft.title.trim(),
          hostName: draft.hostName.trim() || null,
          description: draft.description.trim() || null,
          location: draft.location.trim() || null,
          eventType: draft.eventType || 'other',
          startsAt: time.startsAt,
          endsAt: time.endsAt,
          enteredTz: enteredTz(mode),
          visibility: draft.visibility,
          playlistOrder: 'shuffle',
          ...(owner.trim() ? { ownerDiscordId: owner.trim() } : {}),
          openTicket,
        },
      })
      window.location.assign(`/staff/events/${r.event.id}`)
    } catch (e) {
      setErr(evMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <section className="card space-y-5">
        <p className="text-sm text-cream/75">
          A direct booking is approved straight away. Use it for &quot;booked, no details&quot; slots (keep it private) or to book for a member. Staff may book up to the {config.gapMin}-minute gap,
          but not over another event.
        </p>
        <DetailsFields value={draft} onChange={(d) => setDraft({ ...draft, ...d })} errors={detailErrors} showErrors={showErrors} />
        <TimeFields value={draft} onChange={(w) => setDraft({ ...draft, ...w })} check={time} busy={avail.busy} busyLoading={avail.loading} busyError={avail.error} maxHours={72} showErrors={showErrors} />
        <VisibilityFields value={draft.visibility} onChange={(v) => setDraft({ ...draft, visibility: v })} showErrors={showErrors} />
        <div>
          <label htmlFor="sb-owner" className="label">
            Book for a member (optional Discord user id)
          </label>
          <input id="sb-owner" className="input" inputMode="numeric" value={owner} onChange={(e) => setOwner(e.target.value)} />
          <p className="ev-field-hint">Leave empty to own the booking yourself.</p>
          {ownerErr ? (
            <p className="mt-1 text-xs text-rose-300" role="alert">
              {ownerErr}
            </p>
          ) : null}
        </div>
        <label className="flex items-start gap-3 text-sm text-cream/85">
          <input type="checkbox" className="checkbox mt-0.5" checked={openTicket} onChange={(e) => setOpenTicket(e.target.checked)} />
          <span>Open a Discord ticket for this booking</span>
        </label>
        {err ? <Notice tone="error">{err}</Notice> : null}
        <button type="button" className="btn btn-primary" onClick={() => void book()} disabled={busy}>
          {busy ? 'Booking…' : 'Book it'}
        </button>
      </section>
    </div>
  )
}

const SETTING_LABEL: Record<EventsSettingKey, { label: string; help?: string }> = {
  events_enabled: { label: 'Members can request events', help: 'Off: only staff can book.' },
  events_autobuild_enabled: { label: 'Build approved events automatically', help: 'Off: staff press "Build now".' },
  events_uploads_enabled: { label: 'Members can upload audio' },
  events_min_notice_h: { label: 'Minimum notice (hours)' },
  events_warn_notice_h: { label: 'Short-notice warning under (hours)' },
  events_member_max_hours: { label: 'Longest member event (hours)' },
  events_member_horizon_days: { label: 'Furthest ahead (days)' },
  events_member_max_pending: { label: 'Requests waiting per member' },
  events_member_max_upcoming: { label: 'Upcoming approved events per member' },
  events_member_daily_creates: { label: 'New requests per member per day' },
  events_gap_min: { label: 'Gap between events (minutes)' },
  events_freeze_min: { label: 'Changes lock before start (minutes)' },
  events_max_rows: { label: 'Schedule rows per event' },
  events_audio_max_items: { label: 'My audio items per member' },
  events_staging_budget_bytes: { label: 'Upload staging budget (bytes)' },
  events_audio_unused_days: { label: 'Delete unused audio after (days)' },
  events_pin_strategy: { label: 'Pinned-song strategy' },
  events_announce_strategy: { label: 'Announcement strategy' },
  events_end_wait_s: { label: 'End: wait for the last song (seconds)' },
}

export function StaffSettings() {
  const { data, error } = useJson<EventsSettings>('/api/ev/admin/settings')
  const [form, setForm] = useState<EventsSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  useEffect(() => {
    if (data) setForm({ ...EVENTS_SETTING_DEFAULTS, ...data })
  }, [data])
  if (error) return <Notice tone="error">Couldn&apos;t load the settings.</Notice>
  if (!form || !data) return <p className="text-sm text-cream/60">Loading…</p>
  const changed = EVENTS_SETTING_KEYS.filter((k) => form[k] !== data[k])
  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const patch = Object.fromEntries(changed.map((k) => [k, form[k]]))
      const r = await api<EventsSettings>('/api/ev/admin/settings', { method: 'PUT', json: patch })
      setForm({ ...EVENTS_SETTING_DEFAULTS, ...r })
      setMsg({ tone: 'ok', text: 'Saved.' })
    } catch (e) {
      setMsg({ tone: 'error', text: evMessage(e) })
    } finally {
      setBusy(false)
    }
  }
  const set = <K extends EventsSettingKey>(k: K, v: EventsSettings[K]) => setForm({ ...form, [k]: v })
  return (
    <section className="card space-y-4">
      {EVENTS_SETTING_KEYS.map((k) => {
        const meta = SETTING_LABEL[k]
        const v = form[k]
        const id = `set-${k}`
        if (typeof v === 'boolean')
          return (
            <label key={k} className="flex items-start gap-3 text-sm text-cream/85">
              <input id={id} type="checkbox" className="checkbox mt-0.5" checked={v} onChange={(e) => set(k, e.target.checked as never)} />
              <span>
                <span className="block font-semibold text-cream">{meta.label}</span>
                {meta.help ? <span className="block text-xs text-cream/60">{meta.help}</span> : null}
              </span>
            </label>
          )
        if (k === 'events_pin_strategy' || k === 'events_announce_strategy') {
          const opts = k === 'events_pin_strategy' ? PIN_STRATEGIES : ANNOUNCE_STRATEGIES
          return (
            <div key={k}>
              <label htmlFor={id} className="label">
                {meta.label}
              </label>
              <select id={id} className="input ev-select" value={String(v)} onChange={(e) => set(k, e.target.value as never)}>
                {opts.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
          )
        }
        return (
          <div key={k}>
            <label htmlFor={id} className="label">
              {meta.label}
            </label>
            <input id={id} type="number" inputMode="numeric" className="input" value={String(v)} onChange={(e) => set(k, (Number.parseInt(e.target.value, 10) || 0) as never)} />
          </div>
        )
      })}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !changed.length}>
        {busy ? 'Saving…' : changed.length ? `Save ${changed.length} change${changed.length > 1 ? 's' : ''}` : 'No changes'}
      </button>
    </section>
  )
}
