'use client'

// The playlist builder: library search (GET /api/ev/library), songs from My
// audio, explicit Up/Down reordering, no duplicates, shuffle/sequential,
// optional pin time per song, and announcements (EFM stingers or My audio)
// "at" a time or "every N min" between two times. Pure rules: playlist.ts.

import { useEffect, useMemo, useState } from 'react'
import { useDebounced, useJson } from '@/components/hooks'
import { EVERY_MIN_OPTIONS } from '@/events/contract/rules'
import type { EveryMin } from '@/events/contract/types'
import {
  addTrack,
  annSlots,
  type BAnn,
  type BTrack,
  type Builder,
  checkAnnouncement,
  checkPin,
  estimateRows,
  moveTrack,
  pinSlots,
  removeAt,
  runningLength,
  trackId,
} from './playlist'
import { formatDuration, formatIn, formatLength, MIN, slots5, zoneLabel } from './time'
import { type AudioItem, listOf, type LibrarySong, type Stinger } from './types'
import { useTz } from './tz'

let keySeq = 0
export const newKey = () => `k${++keySeq}-${Date.now().toString(36)}`

// Library titles remembered from search results in this browser: a fallback
// for a saved track whose view carries no server-resolved `label`.
const TITLE_KEY = 'efm_ev_titles'
export function rememberTitles(rows: LibrarySong[]) {
  try {
    const m = JSON.parse(window.localStorage.getItem(TITLE_KEY) ?? '{}') as Record<string, [string, string | null, number | null]>
    for (const r of rows) m[r.mediaId] = [r.title, r.artist, r.lengthS]
    const keys = Object.keys(m)
    if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete m[k]
    window.localStorage.setItem(TITLE_KEY, JSON.stringify(m))
  } catch {
    // storage blocked
  }
}
export function recallTitle(mediaId: number): { title: string; artist: string | null; lengthS: number | null } | null {
  try {
    const m = JSON.parse(window.localStorage.getItem(TITLE_KEY) ?? '{}') as Record<string, [string, string | null, number | null]>
    const r = m[mediaId]
    return r ? { title: r[0], artist: r[1], lengthS: r[2] } : null
  } catch {
    return null
  }
}

function SlotSelect({ id, label, value, slots, onChange, allowNone, noneLabel = 'No pin' }: { id: string; label: string; value: string | null; slots: number[]; onChange: (v: string | null) => void; allowNone?: boolean; noneLabel?: string }) {
  const { mode } = useTz()
  const cur = value ? Date.parse(value) : null
  const opts = cur != null && !slots.includes(cur) ? [cur, ...slots] : slots
  return (
    <label htmlFor={id} className="block">
      <span className="label">{label}</span>
      <select id={id} className="input ev-select" value={cur ?? ''} onChange={(e) => onChange(e.target.value ? new Date(Number(e.target.value)).toISOString() : null)}>
        {allowNone ? <option value="">{noneLabel}</option> : <option value="">Choose a time…</option>}
        {opts.map((t) => (
          <option key={t} value={t}>
            {formatIn(t, mode, 'short')} {zoneLabel(t, mode)}
          </option>
        ))}
      </select>
    </label>
  )
}

export function PlaylistBuilder({
  value,
  onChange,
  start,
  end,
  maxRows,
  uploadsEnabled,
}: {
  value: Builder
  onChange: (b: Builder) => void
  start: string
  end: string
  maxRows: number
  uploadsEnabled: boolean
}) {
  const { mode } = useTz()
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 350)
  const [msg, setMsg] = useState<string | null>(null)
  const lib = useJson<unknown>(dq.length >= 2 ? `/api/ev/library?q=${encodeURIComponent(dq)}` : null)
  const results = useMemo(() => listOf<LibrarySong>(lib.data), [lib.data])
  useEffect(() => {
    if (results.length) rememberTitles(results)
  }, [results])
  const audio = useJson<unknown>('/api/ev/audio')
  const myAudio = useMemo(() => listOf<AudioItem>(audio.data).filter((a) => a.status === 'ready' || a.status === 'live'), [audio.data])
  const stingersRes = useJson<unknown>('/api/ev/stingers')
  const stingers = useMemo(() => listOf<Stinger>(stingersRes.data), [stingersRes.data])

  const ids = new Set(value.tracks.map(trackId))
  const set = (patch: Partial<Builder>) => onChange({ ...value, ...patch })

  const add = (t: BTrack) => {
    const r = addTrack(value.tracks, t)
    setMsg(r.error)
    if (!r.error) set({ tracks: r.list })
  }
  const addLibrary = (s: LibrarySong) =>
    add({ key: newKey(), source: 'library', mediaId: s.mediaId, audioId: null, title: s.title, artist: s.artist, lengthS: s.lengthS, pinAt: null })
  const addUpload = (a: AudioItem) => add({ key: newKey(), source: 'upload', mediaId: null, audioId: a.id, title: a.title, artist: a.artist, lengthS: a.durationS, pinAt: null })

  const pins = useMemo(() => pinSlots(start, end), [start, end])
  const run = runningLength(value.tracks)
  const eventS = (Date.parse(end) - Date.parse(start)) / 1000
  const rows = estimateRows(value, start, end)

  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-labelledby="pb-order">
        <h3 id="pb-order" className="font-semibold text-cream">
          Play order
        </h3>
        <div className="ev-seg" role="group" aria-label="Play order">
          <button type="button" aria-pressed={value.order === 'shuffle'} onClick={() => set({ order: 'shuffle' })}>
            Shuffle
          </button>
          <button type="button" aria-pressed={value.order === 'sequential'} onClick={() => set({ order: 'sequential' })}>
            In my order
          </button>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="pb-add">
        <h3 id="pb-add" className="font-semibold text-cream">
          Add songs
        </h3>
        <label htmlFor="pb-q" className="label">
          Search the EuphoricFM library
        </label>
        <input id="pb-q" type="search" className="input" placeholder="Song or artist" value={q} onChange={(e) => setQ(e.target.value)} />
        {dq.length >= 2 ? (
          lib.error ? (
            <p className="text-xs text-rose-200">Couldn&apos;t search the library. Try again.</p>
          ) : lib.loading ? (
            <p className="text-xs text-cream/60">Searching…</p>
          ) : results.length ? (
            <ul className="max-h-80 space-y-1 overflow-y-auto pr-1" aria-label="Search results">
              {results.slice(0, 50).map((s) => {
                const added = ids.has(`library:${s.mediaId}`)
                return (
                  <li key={s.mediaId} className="flex items-center gap-2 rounded-xl border border-cream/10 bg-cream/[0.02] px-3 py-2">
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="block truncate text-cream">{s.title}</span>
                      <span className="block truncate text-xs text-cream/60">
                        {s.artist ?? 'Unknown artist'} · {formatLength(s.lengthS)}
                      </span>
                    </span>
                    <button type="button" className="btn btn-secondary btn-sm min-h-[44px]" onClick={() => addLibrary(s)} disabled={added} aria-label={added ? `${s.title} is added` : `Add ${s.title}`}>
                      {added ? 'Added' : 'Add'}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-xs text-cream/60">No songs match &quot;{dq}&quot;.</p>
          )
        ) : (
          <p className="text-xs text-cream/60">Type at least 2 letters.</p>
        )}
        {myAudio.some((a) => a.kind === 'song') ? (
          <details className="disclosure">
            <summary>Add your own songs (My audio)</summary>
            <ul className="mt-2 space-y-1">
              {myAudio
                .filter((a) => a.kind === 'song')
                .map((a) => {
                  const added = ids.has(`upload:${a.id}`)
                  return (
                    <li key={a.id} className="flex items-center gap-2 rounded-xl border border-cream/10 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {a.artist ? `${a.artist} – ` : ''}
                        {a.title} · {formatLength(a.durationS)}
                      </span>
                      <button type="button" className="btn btn-secondary btn-sm min-h-[44px]" onClick={() => addUpload(a)} disabled={added}>
                        {added ? 'Added' : 'Add'}
                      </button>
                    </li>
                  )
                })}
            </ul>
          </details>
        ) : uploadsEnabled ? (
          <p className="text-xs text-cream/60">
            Want to play your own recordings?{' '}
            <a className="link" href="/my/audio">
              Upload them in My audio
            </a>
            .
          </p>
        ) : null}
        {msg ? (
          <p className="notice notice-warn" role="alert">
            {msg}
          </p>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="pb-list">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="pb-list" className="font-semibold text-cream">
            Your songs ({value.tracks.length})
          </h3>
          <p className="text-xs text-cream/70" data-testid="pb-length">
            Songs: {formatDuration(run.seconds * 1000)}
            {run.unknown ? ` + ${run.unknown} of unknown length` : ''} · Event: {formatDuration(eventS * 1000)}
          </p>
        </div>
        {value.tracks.length ? (
          <>
            <progress className="progress" max={Math.max(eventS, 1)} value={Math.min(run.seconds, eventS)} aria-label="Songs compared with the event length" />
            <p className="text-xs text-cream/60">
              {run.seconds < eventS
                ? 'Your songs are shorter than the event, so the list plays again from the top.'
                : 'Your songs fill the event. Songs that do not fit before the end will not play.'}{' '}
              {value.order === 'shuffle' ? 'Shuffle plays them in a random order.' : 'They play in the order below.'}
            </p>
          </>
        ) : (
          <p className="notice notice-info">No songs yet. Search the library above and press Add.</p>
        )}
        <ol className="space-y-2">
          {value.tracks.map((t, i) => {
            const pinErr = checkPin(t.pinAt, start, end)
            return (
              <li key={t.key} className="rounded-xl border border-cream/15 bg-cream/[0.03] p-3" data-testid="pb-track">
                <div className="flex items-start gap-2">
                  <span className="step-num step-num-sm mt-1">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-cream">{t.title}</span>
                    <span className="block truncate text-xs text-cream/60">
                      {t.source === 'upload' ? 'My audio · ' : ''}
                      {t.artist ?? 'Unknown artist'} · {formatLength(t.lengthS)}
                    </span>
                  </span>
                  <button type="button" className="ev-iconbtn" onClick={() => set({ tracks: moveTrack(value.tracks, i, -1) })} disabled={i === 0} aria-label={`Move ${t.title} up`}>
                    ↑ Up
                  </button>
                  <button type="button" className="ev-iconbtn" onClick={() => set({ tracks: moveTrack(value.tracks, i, 1) })} disabled={i === value.tracks.length - 1} aria-label={`Move ${t.title} down`}>
                    ↓ Down
                  </button>
                  <button type="button" className="ev-iconbtn ev-iconbtn-danger" onClick={() => set({ tracks: removeAt(value.tracks, i) })} aria-label={`Remove ${t.title}`}>
                    ✕
                  </button>
                </div>
                <div className="mt-2 max-w-xs">
                  <SlotSelect
                    id={`pin-${t.key}`}
                    label="Pin to a time (optional)"
                    value={t.pinAt}
                    slots={pins}
                    allowNone
                    onChange={(v) => set({ tracks: value.tracks.map((x, k) => (k === i ? { ...x, pinAt: v } : x)) })}
                  />
                  {t.pinAt && !pinErr ? <p className="ev-field-hint">Plays at the first song break after this time.</p> : null}
                  {pinErr ? (
                    <p className="mt-1 text-xs text-rose-300" role="alert">
                      {pinErr}
                    </p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      <AnnouncementsEditor value={value} onChange={onChange} start={start} end={end} stingers={stingers} myAudio={myAudio.filter((a) => a.kind === 'announcement')} />

      <p className={`text-xs ${rows > maxRows ? 'text-rose-300' : 'text-cream/60'}`} data-testid="pb-rows">
        Schedule entries: about {rows} of {maxRows}.{rows > maxRows ? ' That is too many: remove some pins or announcements, or repeat them less often.' : ''}
      </p>
      <p className="sr-only" aria-live="polite">
        {value.tracks.length} songs, {value.anns.length} announcements, times in {mode === 'et' ? 'Eastern' : 'your'} time.
      </p>
    </div>
  )
}

function AnnouncementsEditor({ value, onChange, start, end, stingers, myAudio }: { value: Builder; onChange: (b: Builder) => void; start: string; end: string; stingers: Stinger[]; myAudio: AudioItem[] }) {
  const { mode } = useTz()
  const [src, setSrc] = useState('')
  const [annMode, setAnnMode] = useState<'at' | 'every'>('at')
  const [at, setAt] = useState<string | null>(null)
  const [every, setEvery] = useState<EveryMin>(30)
  const [from, setFrom] = useState<string | null>(null)
  const [until, setUntil] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const slots = useMemo(() => annSlots(start, end), [start, end])
  const untilSlots = useMemo(() => slots5((from ? Date.parse(from) : Date.parse(start)) + 5 * MIN, Date.parse(end)), [from, start, end])

  const fmtAnn = (a: BAnn) =>
    a.mode === 'at'
      ? `at ${a.at ? `${formatIn(a.at, mode, 'short')} ${zoneLabel(a.at, mode)}` : '?'}`
      : `every ${a.everyMin} min, ${a.from ? formatIn(a.from, mode, 'short') : '?'} – ${a.until ? formatIn(a.until, mode, 'time') : '?'} ${a.from ? zoneLabel(a.from, mode) : ''}`

  const addAnn = () => {
    setErr(null)
    const [kind, idStr] = src.split(':')
    const id = Number(idStr)
    if (!kind || !id) {
      setErr('Choose which announcement to play.')
      return
    }
    const st = kind === 'stinger' ? stingers.find((s) => s.mediaId === id) : null
    const up = kind === 'upload' ? myAudio.find((a) => a.id === id) : null
    const a: BAnn = {
      key: newKey(),
      source: kind === 'stinger' ? 'stinger' : 'upload',
      mediaId: kind === 'stinger' ? id : null,
      audioId: kind === 'upload' ? id : null,
      title: st?.title ?? up?.title ?? `Announcement #${id}`,
      lengthS: st?.lengthS ?? up?.durationS ?? null,
      mode: annMode,
      at: annMode === 'at' ? at : null,
      everyMin: annMode === 'every' ? every : null,
      from: annMode === 'every' ? from : null,
      until: annMode === 'every' ? until : null,
    }
    const problem = checkAnnouncement(a, start, end)
    if (problem) {
      setErr(problem)
      return
    }
    onChange({ ...value, anns: [...value.anns, a] })
    setAt(null)
  }

  return (
    <section className="space-y-3" aria-labelledby="pb-ann">
      <h3 id="pb-ann" className="font-semibold text-cream">
        Announcements ({value.anns.length})
      </h3>
      <p className="text-xs text-cream/65">Announcements cut in at their time (the song playing is interrupted), then the music carries on.</p>
      {value.anns.length ? (
        <ul className="space-y-2">
          {value.anns.map((a, i) => {
            const problem = checkAnnouncement(a, start, end)
            return (
              <li key={a.key} className="flex items-start gap-2 rounded-xl border border-cream/15 bg-cream/[0.03] p-3" data-testid="pb-ann">
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate font-medium text-cream">{a.title}</span>
                  <span className="block text-xs text-cream/65">
                    {a.source === 'stinger' ? 'EuphoricFM announcement' : 'My audio'} · {fmtAnn(a)}
                  </span>
                  {problem ? (
                    <span className="mt-1 block text-xs text-rose-300" role="alert">
                      {problem}
                    </span>
                  ) : null}
                </span>
                <button type="button" className="ev-iconbtn ev-iconbtn-danger" onClick={() => onChange({ ...value, anns: removeAt(value.anns, i) })} aria-label={`Remove announcement ${a.title}`}>
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}

      <div className="space-y-3 rounded-xl border border-dashed border-cream/20 p-3">
        <label htmlFor="ann-src" className="block">
          <span className="label">Announcement</span>
          <select id="ann-src" className="input ev-select" value={src} onChange={(e) => setSrc(e.target.value)}>
            <option value="">Choose…</option>
            {stingers.length ? (
              <optgroup label="EuphoricFM announcements">
                {stingers.map((s) => (
                  <option key={s.mediaId} value={`stinger:${s.mediaId}`}>
                    {s.title} ({formatLength(s.lengthS)})
                  </option>
                ))}
              </optgroup>
            ) : null}
            {myAudio.length ? (
              <optgroup label="My audio">
                {myAudio.map((a) => (
                  <option key={a.id} value={`upload:${a.id}`}>
                    {a.title} ({formatLength(a.durationS)})
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <div className="ev-seg" role="group" aria-label="When it plays">
          <button type="button" aria-pressed={annMode === 'at'} onClick={() => setAnnMode('at')}>
            At a time
          </button>
          <button type="button" aria-pressed={annMode === 'every'} onClick={() => setAnnMode('every')}>
            On repeat
          </button>
        </div>
        {annMode === 'at' ? (
          <SlotSelect id="ann-at" label="Plays at" value={at} slots={slots} onChange={setAt} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <label htmlFor="ann-every" className="block">
              <span className="label">Every</span>
              <select id="ann-every" className="input ev-select" value={every} onChange={(e) => setEvery(Number(e.target.value) as EveryMin)}>
                {EVERY_MIN_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </select>
            </label>
            <SlotSelect id="ann-from" label="From" value={from} slots={slots} onChange={setFrom} />
            <SlotSelect id="ann-until" label="Until" value={until} slots={untilSlots} onChange={setUntil} />
          </div>
        )}
        <button type="button" className="btn btn-secondary" onClick={addAnn}>
          Add announcement
        </button>
        {err ? (
          <p className="text-xs text-rose-300" role="alert">
            {err}
          </p>
        ) : null}
      </div>
    </section>
  )
}
