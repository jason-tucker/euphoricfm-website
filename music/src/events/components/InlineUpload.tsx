'use client'

// "Upload a new announcement" / "Upload a song" inside the request form
// (0.5.3): the My audio upload (upload.ts) without leaving the page. After
// the attach it polls GET /api/ev/audio until the file is checked, then hands
// the Ready row to `onReady` (the form adds it and autosaves). Respects
// uploadsEnabled=false and the per-member My audio cap.

import { useEffect, useRef, useState } from 'react'
import { ACCEPT } from '@/components/submit/types'
import { Notice } from '@/components/ui'
import { AUDIO_ARTIST_MAX, AUDIO_TITLE_MAX } from '@/events/contract/rules'
import { api } from './ev-api'
import { useEvConfig } from './hooks'
import { type AudioItem, listOf } from './types'
import { audioProblemText, mb, uploadFormProblem, useAudioUpload } from './upload'

export const POLL_MS = 3000
const READY = new Set<AudioItem['status']>(['ready', 'ingesting', 'live'])
const BAD = new Set<AudioItem['status']>(['rejected', 'failed'])

export function InlineUpload({
  kind,
  chunkBytes,
  audioCount,
  onReady,
}: {
  kind: 'announcement' | 'song'
  chunkBytes: number
  /** My audio rows that count against the cap (not rejected/failed). */
  audioCount: number
  onReady: (a: AudioItem) => void
}) {
  const { config, loaded } = useEvConfig()
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [rights, setRights] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [waitingId, setWaitingId] = useState<number | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const limits = { mp3: config.caps.mp3Bytes, wav: config.caps.wavBytes }
  const { pending, setPending, start, busy } = useAudioUpload({
    chunkBytes,
    limits,
    onAttached: (a) => {
      setPending((p) => (p ? { ...p, phase: 'processing', progress: 1 } : p))
      setWaitingId(a.id)
    },
  })
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const noun = kind === 'song' ? 'song' : 'announcement'
  const idp = `iu-${kind}`

  // Poll until the checker has looked at the file.
  useEffect(() => {
    if (waitingId === null) return
    let live = true
    const tick = async () => {
      try {
        const a = listOf<AudioItem>(await api<unknown>('/api/ev/audio')).find((x) => x.id === waitingId)
        if (!live || !a) return
        if (READY.has(a.status)) {
          live = false
          setWaitingId(null)
          setPending(null)
          setFile(null)
          setTitle('')
          setArtist('')
          setRights(false)
          if (fileRef.current) fileRef.current.value = ''
          setOpen(false)
          setDone(a.title)
          onReadyRef.current(a)
        } else if (BAD.has(a.status)) {
          live = false
          setWaitingId(null)
          setPending((p) => (p ? { ...p, phase: 'error', error: audioProblemText(a, config.caps.minDurationByKind) } : p))
        }
      } catch {
        // keep polling: a blip must not lose the upload (it stays in My audio)
      }
    }
    void tick()
    const t = setInterval(() => void tick(), POLL_MS)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [waitingId, setPending, config.caps.minDurationByKind])

  if (!loaded) return null
  if (!config.uploadsEnabled) {
    return (
      <p className="text-xs text-cream/60" data-testid={`${idp}-off`}>
        Uploading your own audio isn&apos;t switched on yet. {kind === 'song' ? 'Use songs from the EuphoricFM library.' : 'Use the EuphoricFM announcement set for now.'}
      </p>
    )
  }
  const full = audioCount >= config.audioMaxItems

  const submit = () => {
    setFormErr(null)
    setDone(null)
    const problem = uploadFormProblem({ file, kind, title, artist, rights }, limits)
    if (problem || !file) return setFormErr(problem)
    start(file, { kind, title, artist })
  }

  return (
    <div className="space-y-3">
      {done ? (
        <p className="notice notice-ok" role="status">
          &quot;{done}&quot; is ready{kind === 'song' ? ' and added to your songs.' : '. It is selected below: pick when it plays.'}
        </p>
      ) : null}
      {!open ? (
        full ? (
          <p className="text-xs text-cream/70">
            Your My audio is full ({config.audioMaxItems} files). To upload another {noun}, delete something you no longer need in{' '}
            <a className="link" href="/my/audio">
              My audio
            </a>
            .
          </p>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
            {kind === 'song' ? 'Upload a song' : 'Upload a new announcement'}
          </button>
        )
      ) : (
        <div className="space-y-3 rounded-xl border border-cream/15 bg-cream/[0.03] p-3" role="group" aria-labelledby={`${idp}-h`}>
          <h4 id={`${idp}-h`} className="text-sm font-semibold text-cream">
            {kind === 'song' ? 'Upload a song' : 'Upload a new announcement'}
          </h4>
          <p className="text-xs text-cream/70">
            MP3 up to {mb(config.caps.mp3Bytes)} MB or WAV up to {mb(config.caps.wavBytes)} MB. {kind === 'song' ? 'Songs' : 'Announcements'} must be at least{' '}
            {config.caps.minDurationByKind[kind]} seconds long. It is also kept in My audio for your next event.
          </p>
          <div>
            <label htmlFor={`${idp}-file`} className="label">
              File
            </label>
            <input ref={fileRef} id={`${idp}-file`} type="file" accept={ACCEPT} className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${idp}-title`} className="label">
                Title
              </label>
              <input id={`${idp}-title`} className="input" value={title} maxLength={AUDIO_TITLE_MAX + 10} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
            </div>
            {kind === 'song' ? (
              <div>
                <label htmlFor={`${idp}-artist`} className="label">
                  Artist
                </label>
                <input id={`${idp}-artist`} className="input" value={artist} maxLength={AUDIO_ARTIST_MAX + 10} onChange={(e) => setArtist(e.target.value)} disabled={busy} />
              </div>
            ) : null}
          </div>
          <label className="flex items-start gap-3 text-sm text-cream/85">
            <input type="checkbox" className="checkbox mt-0.5" checked={rights} onChange={(e) => setRights(e.target.checked)} disabled={busy} />
            <span>I made this audio or have permission to play it on EuphoricFM, and it contains nothing illegal or hateful.</span>
          </label>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
              Upload
            </button>
            {!busy ? (
              <button type="button" className="btn btn-secondary" onClick={() => (setOpen(false), setFormErr(null), setPending(null))}>
                Cancel
              </button>
            ) : null}
          </div>
          {formErr ? (
            <p className="text-sm text-rose-300" role="alert">
              {formErr}
            </p>
          ) : null}
          {pending ? (
            <div className="space-y-1" aria-live="polite" data-testid={`${idp}-progress`}>
              <p className="text-sm text-cream/80">
                {pending.name}:{' '}
                {pending.phase === 'uploading'
                  ? `uploading ${Math.round(pending.progress * 100)} %`
                  : pending.phase === 'attaching'
                    ? 'saving…'
                    : pending.phase === 'processing'
                      ? 'Processing… (checking the file, usually under a minute)'
                      : 'failed'}
              </p>
              <progress className="progress" max={1} value={pending.phase === 'processing' ? undefined : pending.progress} aria-label="Upload progress" />
              {pending.error ? <Notice tone="error">{pending.error}</Notice> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
