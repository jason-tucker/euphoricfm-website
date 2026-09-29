'use client'

// My audio: reusable uploads (announcements or songs). Upload over the
// portal's tus endpoint, attach with POST /api/ev/audio, poll until the
// network-less probe has checked it. Hidden behind a friendly note while
// uploads are switched off (config.uploadsEnabled=false).

import { useCallback, useEffect, useRef, useState } from 'react'
import * as tus from 'tus-js-client'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { errorText, uploadErrorText } from '@/components/messages'
import { ACCEPT, declaredType, precheck } from '@/components/submit/types'
import { Chip, Notice } from '@/components/ui'
import { AUDIO_ARTIST_MAX, AUDIO_TITLE_MAX } from '@/events/contract/rules'
import { api, evMessage } from './ev-api'
import { useEvConfig } from './hooks'
import { formatLength } from './time'
import { type AudioItem, listOf } from './types'
import { When } from './tz'

const STATUS: Record<AudioItem['status'], { label: string; tone: 'pending' | 'progress' | 'live' | 'bad' }> = {
  probing: { label: 'Checking…', tone: 'progress' },
  ready: { label: 'Ready', tone: 'live' },
  ingesting: { label: 'Ready', tone: 'live' },
  live: { label: 'Ready', tone: 'live' },
  rejected: { label: 'Rejected', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
}

const mb = (n: number) => Math.round(n / 1024 / 1024)

function tusErrorText(err: unknown, limits: { mp3: number; wav: number }): string {
  const e = err as { originalResponse?: { getStatus(): number; getBody(): string } | null }
  const status = e.originalResponse?.getStatus() ?? 0
  if (!status) return errorText('network')
  let code = ''
  try {
    const j = JSON.parse(e.originalResponse?.getBody() ?? '') as { error?: string }
    code = typeof j.error === 'string' ? j.error : ''
  } catch {
    code = ''
  }
  if (code === 'uploads_disabled') return 'Uploads are switched off right now.'
  return code ? uploadErrorText(code, status, limits) : errorText(`http_${status}`, status)
}

type Pending = { name: string; progress: number; phase: 'uploading' | 'attaching' | 'error'; error?: string }

export function MyAudio({ chunkBytes }: { chunkBytes: number }) {
  const { config, loaded } = useEvConfig()
  const [items, setItems] = useState<AudioItem[] | null>(null)
  const [loadErr, setLoadErr] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [kind, setKind] = useState<'announcement' | 'song'>('announcement')
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [rights, setRights] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [del, setDel] = useState<AudioItem | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const upload = useRef<tus.Upload | null>(null)

  const load = useCallback(async () => {
    try {
      setItems(listOf<AudioItem>(await api<unknown>('/api/ev/audio')))
      setLoadErr(false)
    } catch {
      setLoadErr(true)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => {
      void upload.current?.abort(false)
    }
  }, [load])

  // Poll while anything is still being checked.
  const probing = items?.some((i) => i.status === 'probing') ?? false
  useEffect(() => {
    if (!probing) return
    const t = setInterval(() => void load(), 4000)
    return () => clearInterval(t)
  }, [probing, load])

  const limits = { mp3: config.caps.mp3Bytes, wav: config.caps.wavBytes }
  const count = items?.length ?? 0
  const full = count >= config.audioMaxItems

  const start = () => {
    setFormErr(null)
    setMsg(null)
    if (!file) return setFormErr('Choose a file first.')
    const pre = precheck(file, limits)
    if (pre.block) return setFormErr(pre.block)
    if (!title.trim()) return setFormErr('Give it a title (this is what you pick it by later).')
    if (title.trim().length > AUDIO_TITLE_MAX) return setFormErr(`Keep the title to ${AUDIO_TITLE_MAX} characters or fewer.`)
    if (kind === 'song' && !artist.trim()) return setFormErr('Songs need an artist name.')
    if (!rights) return setFormErr('Confirm that you have the rights to this audio.')
    setPending({ name: file.name, progress: 0, phase: 'uploading' })
    const up = new tus.Upload(file, {
      endpoint: '/api/uploads',
      chunkSize: chunkBytes,
      metadata: { filetype: declaredType(file) },
      retryDelays: [0, 1000, 3000, 5000, 10000],
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      onProgress: (sent, total) => setPending((p) => (p ? { ...p, progress: total ? sent / total : 0 } : p)),
      onShouldRetry: (err) => {
        const s = (err as { originalResponse?: { getStatus(): number } | null }).originalResponse?.getStatus() ?? 0
        return s === 0 || s === 423 || s === 429 || s >= 500
      },
      onError: (err) => setPending((p) => (p ? { ...p, phase: 'error', error: tusErrorText(err, limits) } : p)),
      onSuccess: () => void attach(up.url),
    })
    upload.current = up
    up.findPreviousUploads()
      .then((prev) => {
        if (prev.length) up.resumeFromPreviousUpload(prev[0]!)
      })
      .catch(() => {})
      .finally(() => up.start())
  }

  const attach = async (url: string | null) => {
    const m = /([0-9a-f]{32})\/?$/.exec(url ?? '')
    if (!m) {
      setPending((p) => (p ? { ...p, phase: 'error', error: 'The upload finished but its id was not returned. Try again.' } : p))
      return
    }
    setPending((p) => (p ? { ...p, phase: 'attaching', progress: 1 } : p))
    try {
      await api('/api/ev/audio', { json: { uploadId: m[1], kind, title: title.trim(), artist: kind === 'song' ? artist.trim() : null } })
      setPending(null)
      setFile(null)
      setTitle('')
      setArtist('')
      setRights(false)
      setMsg("Uploaded. We're checking the file; it shows Ready when it can be used.")
      await load()
    } catch (e) {
      setPending((p) => (p ? { ...p, phase: 'error', error: evMessage(e) } : p))
    }
  }

  const remove = async () => {
    if (!del) return
    setDelBusy(true)
    try {
      await api(`/api/ev/audio/${del.id}`, { method: 'DELETE' })
      setMsg(`"${del.title}" deleted.`)
      await load()
    } catch (e) {
      setMsg(evMessage(e))
    } finally {
      setDelBusy(false)
      setDel(null)
    }
  }

  return (
    <div className="space-y-6">
      {loaded && !config.uploadsEnabled ? (
        <Notice tone="info">
          Uploading your own audio isn&apos;t switched on yet. You can still build a full event from the EuphoricFM library and our announcement set. Need a special recording? Ask in your
          ticket.
        </Notice>
      ) : (
        <section className="card space-y-4" aria-labelledby="ma-up">
          <h2 id="ma-up" className="text-lg font-bold text-cream">
            Upload audio
          </h2>
          <p className="text-sm text-cream/75">
            MP3 up to {mb(config.caps.mp3Bytes)} MB or WAV up to {mb(config.caps.wavBytes)} MB, at most {Math.round(config.caps.maxDurationS / 60)} minutes. Need a longer file? Ask in your
            ticket. You can keep up to {config.audioMaxItems} files ({count} used).
          </p>
          {full ? (
            <Notice tone="warn">Your My audio is full. Delete something you no longer need first.</Notice>
          ) : (
            <>
              <div>
                <label htmlFor="ma-file" className="label">
                  File
                </label>
                <input id="ma-file" type="file" accept={ACCEPT} className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={!!pending && pending.phase !== 'error'} />
              </div>
              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="label">What is it?</legend>
                <label className="ev-choice">
                  <input type="radio" name="ma-kind" checked={kind === 'announcement'} onChange={() => setKind('announcement')} />
                  <span>
                    <span className="block font-semibold text-cream">Announcement</span>
                    <span className="block text-xs text-cream/70">A shoutout or message that cuts in at a set time.</span>
                  </span>
                </label>
                <label className="ev-choice">
                  <input type="radio" name="ma-kind" checked={kind === 'song'} onChange={() => setKind('song')} />
                  <span>
                    <span className="block font-semibold text-cream">Song</span>
                    <span className="block text-xs text-cream/70">Plays with your other songs. Only at your events, never in normal rotation.</span>
                  </span>
                </label>
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="ma-title" className="label">
                    Title
                  </label>
                  <input id="ma-title" className="input" value={title} maxLength={AUDIO_TITLE_MAX + 10} onChange={(e) => setTitle(e.target.value)} />
                </div>
                {kind === 'song' ? (
                  <div>
                    <label htmlFor="ma-artist" className="label">
                      Artist
                    </label>
                    <input id="ma-artist" className="input" value={artist} maxLength={AUDIO_ARTIST_MAX + 10} onChange={(e) => setArtist(e.target.value)} />
                  </div>
                ) : null}
              </div>
              <label className="flex items-start gap-3 text-sm text-cream/85">
                <input type="checkbox" className="checkbox mt-0.5" checked={rights} onChange={(e) => setRights(e.target.checked)} />
                <span>I made this audio or have permission to play it on EuphoricFM, and it contains nothing illegal or hateful.</span>
              </label>
              <button type="button" className="btn btn-primary" onClick={start} disabled={!!pending && pending.phase !== 'error'}>
                Upload
              </button>
              {formErr ? (
                <p className="text-sm text-rose-300" role="alert">
                  {formErr}
                </p>
              ) : null}
              {pending ? (
                <div className="space-y-1" aria-live="polite">
                  <p className="text-sm text-cream/80">
                    {pending.name}: {pending.phase === 'uploading' ? `uploading ${Math.round(pending.progress * 100)} %` : pending.phase === 'attaching' ? 'saving…' : 'failed'}
                  </p>
                  <progress className="progress" max={1} value={pending.progress} aria-label="Upload progress" />
                  {pending.error ? <Notice tone="error">{pending.error}</Notice> : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      )}

      {msg ? <Notice tone="info">{msg}</Notice> : null}

      <section className="space-y-3" aria-labelledby="ma-list">
        <h2 id="ma-list" className="text-lg font-bold text-cream">
          Your audio ({count})
        </h2>
        {loadErr ? (
          <Notice tone="error">Couldn&apos;t load your audio. Try again in a minute.</Notice>
        ) : !items ? (
          <p className="text-sm text-cream/60">Loading…</p>
        ) : items.length ? (
          <ul className="space-y-2">
            {items.map((a) => (
              <AudioRowView key={a.id} a={a} onDelete={() => setDel(a)} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-cream/60">Nothing here yet.</p>
        )}
      </section>

      <ConfirmDialog open={!!del} title="Delete this audio?" confirmLabel="Delete" confirmClass="btn-danger" busy={delBusy} onConfirm={() => void remove()} onCancel={() => setDel(null)}>
        <p>&quot;{del?.title}&quot; will be removed from My audio. Audio used by an upcoming event can&apos;t be deleted until the event is over.</p>
      </ConfirmDialog>
    </div>
  )
}

function AudioRowView({ a, onDelete }: { a: AudioItem; onDelete: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const s = STATUS[a.status] ?? { label: a.status, tone: 'pending' as const }
  const preview = async () => {
    setErr(null)
    try {
      setUrl((await api<{ url: string }>(`/api/ev/audio/${a.id}/preview`)).url)
    } catch (e) {
      setErr(evMessage(e))
    }
  }
  return (
    <li className="space-y-2 rounded-xl border border-cream/15 bg-cream/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-cream">{a.title}</span>
          <span className="block text-xs text-cream/60">
            {a.kind === 'song' ? `Song${a.artist ? ` · ${a.artist}` : ''}` : 'Announcement'} · {formatLength(a.durationS)}
          </span>
        </span>
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>
      {a.status === 'rejected' || a.status === 'failed' ? <p className="text-xs text-rose-200">{a.lastError ? `This file can't be used (${a.lastError}).` : "This file can't be used."}</p> : null}
      {a.expiresAt && !a.usedAt ? (
        <p className="text-xs text-cream/60">
          Not used in an event yet: it will be deleted on <When at={a.expiresAt} format="date" /> unless you add it to one.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {a.status === 'ready' || a.status === 'ingesting' || a.status === 'live' ? (
          url ? (
            <audio controls preload="none" src={url} className="w-full min-w-[12rem] flex-1">
              Your browser cannot play this preview.
            </audio>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm min-h-[44px]" onClick={() => void preview()}>
              Preview
            </button>
          )
        ) : null}
        <button type="button" className="btn btn-secondary btn-sm min-h-[44px]" onClick={onDelete}>
          Delete
        </button>
      </div>
      {err ? <p className="text-xs text-rose-200">{err}</p> : null}
    </li>
  )
}
