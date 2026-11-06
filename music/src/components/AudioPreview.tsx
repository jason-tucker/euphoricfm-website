'use client'

// Cover + audio preview through the signed, short-lived media URLs from
// GET /api/items/:id/preview. A URL that expired (audio error) is refreshed
// once automatically.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, messageFor } from './api'

export type Urls = { audioUrl: string; coverUrl: string | null }

export function AudioPreview({
  itemId,
  compact = false,
  hideCover = false,
  onUrls,
}: {
  itemId: number
  compact?: boolean
  // The caller shows the cover itself (e.g. with an ArtControl).
  hideCover?: boolean
  onUrls?: (u: Urls) => void
}) {
  const [urls, setUrls] = useState<Urls | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const retried = useRef(false)

  const load = useCallback(async () => {
    try {
      const u = await api<Urls>(`/api/items/${itemId}/preview`)
      setUrls(u)
      onUrls?.(u)
      setErr(null)
    } catch (e) {
      setErr(messageFor(e))
    }
  }, [itemId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className={`flex items-center gap-3 ${compact ? '' : 'flex-wrap'}`}>
      {hideCover ? null : urls?.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={urls.coverUrl} alt="Cover art" className={`${compact ? 'size-14' : 'size-20'} shrink-0 rounded-lg border border-cream/10 object-cover`} />
      ) : (
        <div
          aria-label="No cover art"
          className={`${compact ? 'size-14' : 'size-20'} flex shrink-0 items-center justify-center rounded-lg border border-dashed border-cream/20 text-[10px] text-cream/55`}
        >
          No cover
        </div>
      )}
      <div className="min-w-0 flex-1">
        {urls ? (
          <audio
            controls
            preload="none"
            src={urls.audioUrl}
            className="w-full min-w-[12rem]"
            onError={() => {
              if (retried.current) return
              retried.current = true
              void load()
            }}
          >
            Your browser cannot play this preview.
          </audio>
        ) : err ? (
          <p className="text-xs text-rose-200">
            {err}{' '}
            <button type="button" className="link" onClick={() => void load()}>
              Retry
            </button>
          </p>
        ) : (
          <p className="text-xs text-cream/50">Loading preview…</p>
        )}
      </div>
    </div>
  )
}
