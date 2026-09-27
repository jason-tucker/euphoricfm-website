import type { UiItem } from '@/server/ui/queries'

export type Fields = { title: string; artist: string; album: string; genre: string }
export const FIELD_KEYS = ['title', 'artist', 'album', 'genre'] as const

export type Phase =
  | 'blocked' // failed a client pre-check (not uploaded)
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'attaching'
  | 'probing'
  | 'ready'
  | 'rejected'
  | 'error'

export type Entry = {
  key: string
  fileName: string
  size: number
  phase: Phase
  progress: number // 0..1
  warning?: string
  error?: string
  uploadUrl?: string
  itemId?: number
  item?: UiItem
  edits: Fields
}

export function fieldsOf(it: Pick<UiItem, 'title' | 'artist' | 'album' | 'genre'> | undefined): Fields {
  return { title: it?.title ?? '', artist: it?.artist ?? '', album: it?.album ?? '', genre: it?.genre ?? '' }
}

export function changedFields(e: Entry): Partial<Record<keyof Fields, string | null>> {
  const base = fieldsOf(e.item)
  const out: Partial<Record<keyof Fields, string | null>> = {}
  for (const k of FIELD_KEYS) {
    const v = e.edits[k].trim()
    if (v !== base[k].trim()) out[k] = v === '' ? null : v
  }
  return out
}

export const MP3_NAME = /\.mp3$/i

// Client pre-checks are ADVISORY: they save a pointless upload and explain the
// problem early. The server (tus caps + probe) is the authority either way.
export function precheck(file: { name: string; size: number; type: string }, maxBytes: number): { block?: string; warn?: string } {
  if (file.size === 0) return { block: 'This file is empty.' }
  if (file.size > maxBytes) return { block: `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.` }
  if (!MP3_NAME.test(file.name) && file.type !== 'audio/mpeg') return { warn: "This doesn't look like an MP3. It will be checked after upload, and only MP3 files are accepted." }
  return {}
}
