// Small pure formatters shared by server and client components.

export function playlistLabel(names: Record<string, string>, id: number): string {
  const n = names[String(id)]
  return n ? `${n} (#${id})` : `Playlist #${id}`
}

export function duration(s: number | null | undefined): string {
  if (s == null) return ''
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Deterministic UTC date text (server and client render the same string, so
// there is no hydration mismatch).
export function when(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// v0.3.0: an item uploaded as a WAV plays and ships as the probe's MP3.
export const CONVERTED_FROM_WAV = 'Converted from WAV (320 kbps MP3)'

export function convertedLabel(inputFormat: string | null | undefined): string | null {
  return inputFormat === 'wav' ? CONVERTED_FROM_WAV : null
}

export function songName(it: { title?: string | null; artist?: string | null }): string {
  const t = it.title?.trim() || 'Untitled'
  return it.artist?.trim() ? `${it.artist.trim()} – ${t}` : t
}
