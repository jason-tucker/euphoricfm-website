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
  // v0.4.0: 'soundcloud' = added from a SoundCloud link (fileName is the link)
  source?: 'upload' | 'soundcloud'
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
  // v0.4.1: the size of a picked MP3's leading ID3v2 tag (read from its first
  // 10 bytes), so the "converting it down" hint matches the probe's rule
  // (lib/fit.ts mp3FitsUntouched: the tag does not count against the budget).
  id3Size?: number
}

// ID3v2 tag size from a file's first 10 bytes ("ID3", version, flags, a
// syncsafe size), header and v2.4 footer included; 0 when there is none or
// it is malformed (the probe decides then). Mirrors probe/magic.ts.
export function id3TagBytes(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0
  const major = head[3]!
  if (major < 2 || major > 4 || head[4] === 0xff) return 0
  const s = [head[6]!, head[7]!, head[8]!, head[9]!]
  if (s.some((b) => b & 0x80)) return 0
  const size = (s[0]! << 21) | (s[1]! << 14) | (s[2]! << 7) | s[3]!
  return 10 + size + (major === 4 && head[5]! & 0x10 ? 10 : 0)
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
export const WAV_NAME = /\.wav$/i
export const WAV_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']
// The file picker's accept list (v0.3.0: WAV too).
export const ACCEPT = ['.mp3', '.wav', 'audio/mpeg', ...WAV_TYPES].join(',')

export type Limits = { mp3: number; wav: number }
export type FileKind = 'mp3' | 'wav' | 'unknown'

// What the file LOOKS like from its name / browser type. Only picks the
// per-file limit and the tus `filetype` the server caps by; the probe decides
// the real type from the bytes.
export function fileKind(file: { name: string; type: string }): FileKind {
  if (WAV_NAME.test(file.name) || WAV_TYPES.includes(file.type.toLowerCase())) return 'wav'
  if (MP3_NAME.test(file.name) || file.type === 'audio/mpeg') return 'mp3'
  return 'unknown'
}

// Sent as tus Upload-Metadata `filetype`: the server allows the WAV limit
// only for a declared WAV; anything else gets the MP3 limit.
export function declaredType(file: { name: string; type: string }): string {
  return fileKind(file) === 'wav' ? 'audio/wav' : 'audio/mpeg'
}

const mb = (n: number) => Math.round(n / 1024 / 1024)

// Client pre-checks are ADVISORY: they save a pointless upload and explain the
// problem early. The server (tus caps + probe) is the authority either way.
export function precheck(file: { name: string; size: number; type: string }, limits: Limits): { block?: string; warn?: string } {
  if (file.size === 0) return { block: 'This file is empty.' }
  const kind = fileKind(file)
  const max = kind === 'wav' ? limits.wav : limits.mp3
  const size = `${(file.size / 1024 / 1024).toFixed(1)} MB`
  if (file.size > max) {
    return {
      block:
        kind === 'wav'
          ? `This WAV file is ${size}. The limit for WAV files is ${mb(max)} MB.`
          : `This file is ${size}. The limit for MP3 files is ${mb(max)} MB${kind === 'unknown' ? ` (WAV files: ${mb(limits.wav)} MB)` : ''}.`,
    }
  }
  if (kind === 'unknown') return { warn: "This doesn't look like an MP3 or WAV file. It will be checked after upload, and only MP3 and WAV files are accepted." }
  return {}
}
