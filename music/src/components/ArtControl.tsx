'use client'

// Album art control: thumbnail of the effective cover plus upload / replace /
// remove. Upload goes through POST /api/uploads/art, is polled until the
// probe re-encodes it, then handed to `attach` (item art, a manager's
// library art, or an edit request's proposed art, depending on the caller).
// Art is OPTIONAL: with no art, a friendly "No album art" prompt is shown,
// and nothing is ever blocked on it.

import { useEffect, useId, useState } from 'react'
import { precheckArt, uploadArtFile, waitForArt, type ArtId } from '@/lib/api/art'
import { ApiError, messageFor } from './api'
import { errorText } from './messages'
import { Notice } from './ui'
import { Thumb } from './Thumb'

type Phase = 'idle' | 'uploading' | 'processing' | 'attaching' | 'removing'

const REJECT_TEXT: Record<string, string> = {
  too_large: errorText('art_too_large'),
  unsupported_type: errorText('art_type'),
  bad_image: errorText('art_rejected'),
  too_many_pixels: 'That image is too large in pixels. Use one under 10,000 × 10,000.',
}

export function ArtControl({
  src,
  title = 'Album art',
  attach,
  detach,
  canRemove = false,
  removeLabel = 'Remove',
  prompt = 'Add a square JPEG, PNG or WebP (up to 5 MB). Optional, but songs look better with art.',
  onChange,
  disabled = false,
}: {
  src: string | null
  title?: string
  // Receives a READY art id; throws ApiError on failure.
  attach: (artId: ArtId, previewUrl: string | null) => Promise<void>
  // Returns the art to show afterwards (e.g. the embedded cover), or null.
  detach?: () => Promise<string | null>
  canRemove?: boolean
  removeLabel?: string
  prompt?: string
  onChange?: (hasArt: boolean) => void
  disabled?: boolean
}) {
  const id = useId()
  const [shown, setShown] = useState<string | null>(src)
  const [touched, setTouched] = useState(false)
  const [removable, setRemovable] = useState(canRemove)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  // Follow the parent's URL until the user changes the art here.
  useEffect(() => {
    if (!touched) setShown(src)
  }, [src, touched])

  const busy = phase !== 'idle'

  const onFile = async (file: File) => {
    setError(null)
    const bad = precheckArt(file)
    if (bad) return setError(errorText(bad))
    try {
      setPhase('uploading')
      const up = await uploadArtFile(file)
      setPhase('processing')
      const st = await waitForArt(up.artId)
      if (st.status === 'rejected') {
        setError(REJECT_TEXT[st.reason ?? ''] ?? errorText('art_rejected'))
        return
      }
      setPhase('attaching')
      await attach(st.artId, st.previewUrl ?? null)
      setTouched(true)
      setShown(st.previewUrl ?? null)
      setRemovable(Boolean(detach))
      onChange?.(true)
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'art_timeout' ? errorText('art_timeout') : messageFor(e, 'edit'))
    } finally {
      setPhase('idle')
    }
  }

  const onRemove = async () => {
    if (!detach) return
    setError(null)
    setPhase('removing')
    try {
      const next = await detach()
      setTouched(true)
      setShown(next)
      setRemovable(false)
      onChange?.(Boolean(next))
    } catch (e) {
      setError(messageFor(e, 'edit'))
    } finally {
      setPhase('idle')
    }
  }

  const status =
    phase === 'uploading' ? 'Uploading image…' : phase === 'processing' ? 'Checking and resizing the image…' : phase === 'attaching' ? 'Saving…' : phase === 'removing' ? 'Removing…' : null

  return (
    <div className={`flex flex-wrap items-start gap-3 rounded-xl border p-3 ${shown ? 'border-cream/10' : 'border-gold/40 bg-gold/[0.06]'}`} data-art={shown ? 'set' : 'missing'}>
      <Thumb src={shown} alt={title} size="lg" />
      <div className="min-w-0 flex-1 space-y-2">
        {shown ? (
          <p className="text-sm font-medium">{title}</p>
        ) : (
          <div>
            <p className="text-sm font-semibold text-gold">No album art</p>
            <p className="text-xs text-cream/65">{prompt}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <label
            className={`btn btn-sm focus-within:ring-2 focus-within:ring-sunburst ${shown ? 'btn-secondary' : 'btn-primary'} ${busy || disabled ? 'pointer-events-none opacity-45' : ''}`}
            aria-disabled={busy || disabled}
          >
            <input
              id={`${id}-file`}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              disabled={busy || disabled}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void onFile(f)
              }}
            />
            {shown ? 'Replace art' : 'Upload art'}
          </label>
          {removable && detach && shown ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void onRemove()} disabled={busy || disabled}>
              {removeLabel}
            </button>
          ) : null}
        </div>
        {status ? (
          <p className="text-xs text-sky-300" role="status">
            {status}
          </p>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </div>
  )
}
