'use client'

// Shows a (proposed) art upload by id via GET /api/uploads/art/:artId
// (uploader or reviewer only; signed, short-lived previewUrl).

import { useEffect, useState } from 'react'
import { getArtStatus } from '@/lib/api/art'
import { Thumb } from './Thumb'

export function ArtUploadPreview({ artId, alt }: { artId: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    getArtStatus(artId)
      .then((s) => {
        if (!live) return
        if (s.status === 'ready') setSrc(s.previewUrl ?? null)
        else setNote(s.status === 'processing' ? 'still processing' : 'rejected')
      })
      .catch(() => live && setNote('preview unavailable'))
    return () => {
      live = false
    }
  }, [artId])
  return (
    <span className="inline-flex items-center gap-2">
      <Thumb src={src} alt={alt} size="md" />
      {note ? <span className="text-xs text-cream/55">({note})</span> : null}
    </span>
  )
}
