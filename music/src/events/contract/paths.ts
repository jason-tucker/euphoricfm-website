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
const UPLOAD_ID_RE = /^[0-9a-f]{32}$/

/** A v4-shaped UUID from 32 hex chars (shared by web and worker spool ids). */
export function uuidV4FromHex(hex: string): string {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new EventPathError('bad_uuid_source')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * The probe request id for an events upload: a v4-shaped UUID derived from
 * the (random, unique) tus upload id, so events-web (which writes the probe
 * request) and the events worker (which reads the result) agree without a
 * stored column. The worker imports this function (never a copy);
 * test/events-contract.test.ts pins a known input → output.
 */
export function probeRequestIdForUpload(uploadId: string): string {
  if (!UPLOAD_ID_RE.test(uploadId)) throw new EventPathError('bad_upload_id')
  return uuidV4FromHex(uploadId)
}

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
// travel into Liquidsoap config: AzuraCast turns a name into the variable
// `playlist_<short name>` (ConfigWriter::getPlaylistVariableName over
// Strings::getProgrammaticString), and the one character that survives that
// pipeline AND breaks a Liquidsoap identifier is '~' (rawurlencode leaves it
// alone). On 2026-09-29 the helper name "~EVT1 s1" became
// `playlist_~evt1_s1`, Liquidsoap refused the whole config ("Error 2: Parse
// error") and station 14 went down. So every name built here is safe BY
// CONSTRUCTION: letters, digits, space and basic punctuation only — no '~',
// no quotes other than the apostrophe, no slashes, backslashes, control,
// format or bidi characters (test/events-liq-names.test.ts runs every name
// the compiler can emit through a port of AzuraCast's pipeline).
const NAME_DISALLOWED = /[^\p{L}\p{N} .,'!?&()\-:#+]/gu
const NAME_LEADING = /^[^\p{L}\p{N}]+/u

/**
 * Strict sanitizer for a public playlist name. NFKC-normalises (fullwidth
 * and compatibility forms fold to ASCII), strips combining marks, replaces
 * anything outside the allowlist (including '~') with a space, collapses
 * whitespace, drops leading punctuation, and cuts to `max` code points.
 * Returns '' when nothing usable is left.
 */
export function sanitizePlaylistName(input: string, max = MAIN_NAME_MAX): string {
  let s = String(input).normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC')
  s = s.replace(NAME_DISALLOWED, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(NAME_LEADING, '')
  s = Array.from(s).slice(0, max).join('').trim()
  return s
}

/** The helper-playlist shape `EVT<id> s<n>` / `EVT<id> a<n>`, any case. */
export const HELPER_NAME_SHAPE_RE = /^EVT\d+ [sa]\d+$/i

/**
 * Whether a title (or playlist name) could pass for a helper playlist: the
 * exact helper shape in any case, or anything that folds to it once case,
 * '~' and separators are dropped ("evt1-s1", "~EVT1 s1", "EVT 1 s 1"). Such
 * a title is refused by the API (title_reserved) and never becomes a main
 * playlist name (mainName falls back to 'Event'), so a main playlist can
 * never be mistaken for — or hidden like — a pin / announcement playlist.
 */
export function isReservedPlaylistName(name: string): boolean {
  const s = String(name).normalize('NFKC')
  if (HELPER_NAME_SHAPE_RE.test(s.trim())) return true
  const folded = s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return /^evt\d+[sa]\d+$/.test(folded)
}

/** The main playlist's name: sanitized public title, or 'Private event'. */
export function mainName(view: { visibility: Visibility; title: string }): string {
  if (view.visibility !== 'public') return PRIVATE_PLAYLIST_NAME
  const s = sanitizePlaylistName(view.title)
  return s === '' || s.includes('~') || isReservedPlaylistName(s) || isReservedPlaylistName(view.title) ? 'Event' : s
}

function assertPositiveInt(n: number, code: string) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new EventPathError(code)
}

/** Internal pinned-song playlist `EVT<id> s<n>` (n ≥ 1). ASCII only, no '~'. */
export function pinName(eventId: number, n: number): string {
  assertPositiveInt(eventId, 'bad_event_id')
  assertPositiveInt(n, 'bad_index')
  return `EVT${eventId} s${n}`
}

/** Internal announcement playlist `EVT<id> a<n>` (n ≥ 1). ASCII only, no '~'. */
export function annName(eventId: number, n: number): string {
  assertPositiveInt(eventId, 'bad_event_id')
  assertPositiveInt(n, 'bad_index')
  return `EVT${eventId} a${n}`
}

export const INTERNAL_NAME_RE = /^EVT([1-9]\d{0,15}) ([sa])([1-9]\d{0,5})$/
/**
 * The pre-0.5.2 helper names (`~EVT<id> s<n>`), which broke Liquidsoap.
 * Recognised ONLY to find and delete them (a rebuild supersedes them, the
 * info site hides them); never built, never sent in a playlist body.
 */
export const LEGACY_INTERNAL_NAME_RE = /^~EVT([1-9]\d{0,15}) ([sa])([1-9]\d{0,5})$/

type InternalName = { eventId: number; role: 'pin' | 'announce'; n: number }

function parseWith(re: RegExp, name: string): InternalName | null {
  const m = re.exec(name)
  if (!m || !m[1] || !m[2] || !m[3]) return null
  return { eventId: Number(m[1]), role: m[2] === 's' ? 'pin' : 'announce', n: Number(m[3]) }
}

/** Parse `EVT<id> s<n>` / `EVT<id> a<n>`; null for anything else (incl. legacy names). */
export function parseInternalName(name: string): InternalName | null {
  return parseWith(INTERNAL_NAME_RE, name)
}

/** Parse a current OR legacy (`~EVT…`) helper name. */
export function parseAnyInternalName(name: string): (InternalName & { legacy: boolean }) | null {
  const cur = parseWith(INTERNAL_NAME_RE, name)
  if (cur) return { ...cur, legacy: false }
  const old = parseWith(LEGACY_INTERNAL_NAME_RE, name)
  return old ? { ...old, legacy: true } : null
}

/**
 * Whether a playlist name is one the current build contract may emit
 * (a clean main name or a current helper name): never a legacy '~' name.
 * build.ts treats a plan holding any other name as needing a rebuild.
 */
export function isCurrentPlaylistName(name: string): boolean {
  return !name.includes('~')
}
