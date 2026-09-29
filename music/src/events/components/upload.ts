'use client'

// The one My-audio upload flow, shared by the My audio page and the inline
// "Upload" buttons of the request form (0.5.3): check the form, send the file
// over the portal's tus endpoint, attach it with POST /api/ev/audio. The
// caller decides what happens after the attach (MyAudio reloads its list;
// the inline upload polls until the file is Ready and adds it).

import { useCallback, useEffect, useRef, useState } from 'react'
import * as tus from 'tus-js-client'
import { errorText, uploadErrorText } from '@/components/messages'
import { declaredType, precheck } from '@/components/submit/types'
import { AUDIO_TITLE_MAX } from '@/events/contract/rules'
import { api, evMessage } from './ev-api'
import type { AudioItem } from './types'

export const mb = (n: number) => Math.round(n / 1024 / 1024)

export type UploadLimits = { mp3: number; wav: number }
export type UploadMeta = { kind: 'announcement' | 'song'; title: string; artist: string }

export function tusErrorText(err: unknown, limits: UploadLimits): string {
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

/** The first problem with an upload form, or null when it can be sent. */
export function uploadFormProblem(f: { file: File | null; rights: boolean } & UploadMeta, limits: UploadLimits): string | null {
  if (!f.file) return 'Choose a file first.'
  const pre = precheck(f.file, limits)
  if (pre.block) return pre.block
  if (!f.title.trim()) return 'Give it a title (this is what you pick it by later).'
  if (f.title.trim().length > AUDIO_TITLE_MAX) return `Keep the title to ${AUDIO_TITLE_MAX} characters or fewer.`
  if (f.kind === 'song' && !f.artist.trim()) return 'Songs need an artist name.'
  if (!f.rights) return 'Confirm that you have the rights to this audio.'
  return null
}

/** Why a rejected / failed file can't be used, in words where we have them. */
export function audioProblemText(a: Pick<AudioItem, 'kind' | 'lastError'>, minS: { song: number; announcement: number }): string {
  if (a.lastError === 'too_short') {
    return a.kind === 'song'
      ? `This file can't be used: songs must be at least ${minS.song} seconds long.`
      : `This file can't be used: announcements must be at least ${minS.announcement} seconds long.`
  }
  return a.lastError ? `This file can't be used (${a.lastError}).` : "This file can't be used."
}

export type Pending = { name: string; progress: number; phase: 'uploading' | 'attaching' | 'processing' | 'error'; error?: string }

/**
 * tus upload + attach. `start` resolves nothing; progress and errors live in
 * `pending`. `onAttached` gets the new My audio row (status `probing`).
 */
export function useAudioUpload(opts: { chunkBytes: number; limits: UploadLimits; onAttached: (a: AudioItem) => void }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const upload = useRef<tus.Upload | null>(null)
  const onAttached = useRef(opts.onAttached)
  onAttached.current = opts.onAttached

  useEffect(
    () => () => {
      void upload.current?.abort(false)
    },
    [],
  )

  const fail = (error: string) => setPending((p) => (p ? { ...p, phase: 'error', error } : p))

  const attach = useCallback(async (url: string | null, meta: UploadMeta) => {
    const m = /([0-9a-f]{32})\/?$/.exec(url ?? '')
    if (!m) return fail('The upload finished but its id was not returned. Try again.')
    setPending((p) => (p ? { ...p, phase: 'attaching', progress: 1 } : p))
    try {
      const r = await api<{ audio: AudioItem }>('/api/ev/audio', {
        json: { uploadId: m[1], kind: meta.kind, title: meta.title.trim(), artist: meta.kind === 'song' ? meta.artist.trim() : null },
      })
      onAttached.current(r.audio)
    } catch (e) {
      fail(evMessage(e))
    }
  }, [])

  const start = (file: File, meta: UploadMeta) => {
    const limits = opts.limits
    setPending({ name: file.name, progress: 0, phase: 'uploading' })
    const up = new tus.Upload(file, {
      endpoint: '/api/uploads',
      chunkSize: opts.chunkBytes,
      metadata: { filetype: declaredType(file) },
      retryDelays: [0, 1000, 3000, 5000, 10000],
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      onProgress: (sent, total) => setPending((p) => (p ? { ...p, progress: total ? sent / total : 0 } : p)),
      onShouldRetry: (err) => {
        const s = (err as { originalResponse?: { getStatus(): number } | null }).originalResponse?.getStatus() ?? 0
        return s === 0 || s === 423 || s === 429 || s >= 500
      },
      onError: (err) => fail(tusErrorText(err, limits)),
      onSuccess: () => void attach(up.url, meta),
    })
    upload.current = up
    up.findPreviousUploads()
      .then((prev) => {
        if (prev.length) up.resumeFromPreviousUpload(prev[0]!)
      })
      .catch(() => {})
      .finally(() => up.start())
  }

  const busy = !!pending && pending.phase !== 'error'
  return { pending, setPending, start, busy }
}
