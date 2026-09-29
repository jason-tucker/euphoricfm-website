// EFM Events Portal — station-media path builders and playlist names
// (contract "Paths", plan §3 "Ownership/IDs" and §4). The ONE place event
// paths and playlist names are built; the worker re-checks every live path
// against these regexes before any write.

import { MAIN_NAME_MAX, PRIVATE_PLAYLIST_NAME } from './rules'
import type { Visibility } from './types'

export class EventPathError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'EventPathError'
  }
}

/** A library song an event may use: exactly one artist folder deep. */
export const LIBRARY_FILE_RE = /^Music\/Artists\/[^/]+\/[^/]+$/
/** An EFM stinger (announcement source). */
export const STINGER_FILE_RE = /^EFM Stingers\/[^/]+$/
/** A member's custom audio: Events/Uploads/<snowflake>/evt-a<audio id>.mp3 */
export const EVENT_UPLOAD_RE = /^Events\/Uploads\/(\d{17,20})\/evt-a([1-9]\d{0,15})\.mp3$/
/** The folder every custom-audio file lives under. */
export const EVENT_UPLOAD_ROOT = 'Events/Uploads/'

const SNOWFLAKE_RE = /^\d{17,20}$/

function assertAudioId(audioId: number) {
  if (!Number.isSafeInteger(audioId) || audioId <= 0) throw new EventPathError('bad_audio_id')
}

// `..` and dot-segments are impossible by construction (digits only), and a
// path is re-matched against EVENT_UPLOAD_RE before it is returned.
export function eventUploadPath(discordId: string, audioId: number): string {
  if (typeof discordId !== 'string' || !SNOWFLAKE_RE.test(discordId)) throw new EventPathError('bad_discord_id')
  assertAudioId(audioId)
  const p = `${EVENT_UPLOAD_ROOT}${discordId}/evt-a${audioId}.mp3`
  if (!EVENT_UPLOAD_RE.test(p)) throw new EventPathError('bad_event_upload_path')
  return p
}

/** Parse an upload path; null unless it matches EVENT_UPLOAD_RE exactly. */
export function parseEventUploadPath(path: string): { discordId: string; audioId: number } | null {
  const m = EVENT_UPLOAD_RE.exec(path)
  if (!m || !m[1] || !m[2]) return null
  const audioId = Number(m[2])
  return Number.isSafeInteger(audioId) ? { discordId: m[1], audioId } : null
}

/** True only for the exact path eventUploadPath(discordId, audioId) builds. */
export function isEventUploadPathFor(path: string, discordId: string, audioId: number): boolean {
  try {
    return path === eventUploadPath(discordId, audioId)
  } catch {
    return false
  }
}

export const isLibraryFile = (path: string) => LIBRARY_FILE_RE.test(path)
export const isStingerFile = (path: string) => STINGER_FILE_RE.test(path)

// ---------------------------------------------------------- playlist names

// Playlist names are PUBLIC (now-playing, the info site's Events card) and
// travel into Liquidsoap config: letters, digits, space and basic punctuation
// only. No '~' (reserved for the internal pin/announcement playlists, which
// the info site hides), no quotes other than the apostrophe, no slashes,
// backslashes, control, format or bidi characters.
const NAME_DISALLOWED = /[^\p{L}\p{N} .,'!?&()\-:#+]/gu
const NAME_LEADING = /^[^\p{L}\p{N}]+/u

/**
 * Strict sanitizer for a public playlist name. NFKC-normalises (fullwidth
 * and compatibility forms fold to ASCII), strips combining marks, replaces
 * anything outside the allowlist with a space, collapses whitespace, drops
 * leading punctuation, and cuts to `max` code points. Returns '' when
 * nothing usable is left.
 */
export function sanitizePlaylistName(input: string, max = MAIN_NAME_MAX): string {
  let s = String(input).normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC')
  s = s.replace(NAME_DISALLOWED, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(NAME_LEADING, '')
  s = Array.from(s).slice(0, max).join('').trim()
  return s
}

/** The main playlist's name: sanitized public title, or 'Private event'. */
export function mainName(view: { visibility: Visibility; title: string }): string {
  if (view.visibility !== 'public') return PRIVATE_PLAYLIST_NAME
  const s = sanitizePlaylistName(view.title)
  return s === '' || s.startsWith('~') ? 'Event' : s
}

function assertPositiveInt(n: number, code: string) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new EventPathError(code)
}

/** Internal pinned-song playlist `~EVT<id> s<n>` (n ≥ 1). */
export function pinName(eventId: number, n: number): string {
  assertPositiveInt(eventId, 'bad_event_id')
  assertPositiveInt(n, 'bad_index')
  return `~EVT${eventId} s${n}`
}

/** Internal announcement playlist `~EVT<id> a<n>` (n ≥ 1). */
export function annName(eventId: number, n: number): string {
  assertPositiveInt(eventId, 'bad_event_id')
  assertPositiveInt(n, 'bad_index')
  return `~EVT${eventId} a${n}`
}

export const INTERNAL_NAME_RE = /^~EVT([1-9]\d{0,15}) ([sa])([1-9]\d{0,5})$/

/** Parse `~EVT<id> s<n>` / `~EVT<id> a<n>`; null for anything else. */
export function parseInternalName(name: string): { eventId: number; role: 'pin' | 'announce'; n: number } | null {
  const m = INTERNAL_NAME_RE.exec(name)
  if (!m || !m[1] || !m[2] || !m[3]) return null
  return { eventId: Number(m[1]), role: m[2] === 's' ? 'pin' : 'announce', n: Number(m[3]) }
}
