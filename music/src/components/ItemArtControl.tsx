'use client'

// Art for a pending portal item (submitter in a draft batch, or a reviewer):
// PUT /api/items/:id/art to set, DELETE to fall back to the embedded cover.

import { clearItemArt, setItemArt } from '@/lib/api/art'
import { api } from './api'
import { ArtControl } from './ArtControl'

export function ItemArtControl({
  itemId,
  src,
  hasCustomArt,
  onChange,
  prompt,
}: {
  itemId: number
  src: string | null
  hasCustomArt: boolean
  onChange?: (hasArt: boolean) => void
  prompt?: string
}) {
  return (
    <ArtControl
      src={src}
      canRemove={hasCustomArt}
      removeLabel="Remove uploaded art"
      prompt={prompt}
      onChange={onChange}
      attach={async (artId) => {
        await setItemArt(itemId, artId)
      }}
      detach={async () => {
        await clearItemArt(itemId)
        // Whatever remains (the file's embedded cover) is served by the preview route.
        try {
          const u = await api<{ coverUrl: string | null }>(`/api/items/${itemId}/preview`)
          return u.coverUrl
        } catch {
          return null
        }
      }}
    />
  )
}
