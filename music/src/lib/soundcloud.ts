// SoundCloud links (v0.4.0, plan P5). Pure (no Node imports): the web route,
// the submit page's pre-check, the worker and the tests share it.
//
// The rules mirror music-fetch's own validator (fetch/fetchsvc/urls.py), which
// checks the URL again before anything is requested:
//   * printable ASCII only (no IDN / fullwidth look-alikes), https only, no
//     userinfo, port, percent-encoding or backslash; a short plain fragment
//     (a share link's timestamp, e.g. #t=1:23) is tolerated and dropped;
//   * host exactly soundcloud.com, www.soundcloud.com or m.soundcloud.com
//     (both sent on as soundcloud.com: music-fetch accepts only that) or
//     on.soundcloud.com (a shortlink, which music-fetch resolves with its own
//     redirect checks);
//   * a track is exactly two path segments of [A-Za-z0-9_-], neither a
//     reserved word: sets / playlists, likes, reposts, user pages and site
//     sections are refused as `sc_not_a_track`;
//   * only SoundCloud's own share parameters, each at most once, and they are
//     dropped: the portal stores and forwards a URL REBUILT from the
//     validated parts, never the pasted string.

export const SC_TRACK_HOST = 'soundcloud.com'
export const SC_MOBILE_HOST = 'm.soundcloud.com'
export const SC_WWW_HOST = 'www.soundcloud.com'
export const SC_SHORT_HOST = 'on.soundcloud.com'
export const MAX_SC_URL_LEN = 512

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/
const URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?(#.*)?$/
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,100}$/
const SHORT_ID_RE = /^[A-Za-z0-9]{1,32}$/
const QUERY_VALUE_RE = /^[A-Za-z0-9._~%:/+-]{0,200}$/
// A fragment never reaches the server nor music-fetch (the URL is rebuilt
// without it); only a short plain one is tolerated (#t=1:23 from a share).
const FRAGMENT_RE = /^#[A-Za-z0-9=:._~-]{0,64}$/

export const TOLERATED_QUERY_KEYS = new Set(['si', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'p', 'c', 'in'])

// First path segments that are site sections, not users (fetch: RESERVED_FIRST).
export const RESERVED_FIRST = new Set([
  'discover', 'search', 'stream', 'you', 'charts', 'stations', 'upload', 'settings',
  'messages', 'notifications', 'people', 'pages', 'tags', 'terms-of-use', 'popular',
  'mobile', 'jobs', 'imprint', 'pro', 'signin', 'signup', 'logout', 'go', 'apps',
  'creators', 'artists', 'connect', 'feed', 'home', 'library', 'playlists', 'likes',
  'sets', 'tracks', 'albums', 'reposts', 'following', 'followers', 'groups', 'hc',
  'help', 'explore', 'premium', 'next', 'secret-token', 'oembed', 'player',
])
// Second segments that are user sub-pages (collections), not tracks.
export const RESERVED_SECOND = new Set([
  'sets', 'likes', 'reposts', 'tracks', 'albums', 'popular-tracks', 'followers',
  'following', 'comments', 'spotlight', 'toptracks', 'playlists', 'stations',
  'recommended', 'groups',
])

export type ScUrlCode = 'sc_bad_url' | 'sc_not_a_track'
export type ScUrl = { ok: true; kind: 'track' | 'short'; url: string } | { ok: false; code: ScUrlCode }

const bad = (code: ScUrlCode = 'sc_bad_url'): ScUrl => ({ ok: false, code })

// Leading / trailing whitespace from a paste is tolerated; nothing else is.
export function parseSoundCloudUrl(input: unknown): ScUrl {
  if (typeof input !== 'string') return bad()
  const s = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
  if (!s || s.length > MAX_SC_URL_LEN || !PRINTABLE_ASCII.test(s) || s.includes('\\')) return bad()
  const m = URL_RE.exec(s)
  if (!m) return bad()
  const [, scheme, authority, rawPath, query, fragment] = m
  if (scheme!.toLowerCase() !== 'https') return bad()
  if (/[@:[\]%]/.test(authority!)) return bad()
  const host = authority!.toLowerCase()
  if (host !== SC_TRACK_HOST && host !== SC_MOBILE_HOST && host !== SC_WWW_HOST && host !== SC_SHORT_HOST) return bad()
  if (fragment !== undefined && !FRAGMENT_RE.test(fragment)) return bad()
  if (query !== undefined && query !== '') {
    const seen = new Set<string>()
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=')
      if (eq < 0) return bad()
      const key = pair.slice(0, eq)
      if (!TOLERATED_QUERY_KEYS.has(key) || seen.has(key) || !QUERY_VALUE_RE.test(pair.slice(eq + 1))) return bad()
      seen.add(key)
    }
  }
  let path = rawPath ?? ''
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  const segs = path === '' || path === '/' ? [] : path.slice(1).split('/')
  if (segs.some((x) => !SEGMENT_RE.test(x))) return bad()
  if (host === SC_SHORT_HOST) {
    if (segs.length !== 1 || !SHORT_ID_RE.test(segs[0]!)) return bad()
    return { ok: true, kind: 'short', url: `https://${SC_SHORT_HOST}/${segs[0]}` }
  }
  if (segs.length !== 2) return bad('sc_not_a_track')
  const user = segs[0]!.toLowerCase()
  const track = segs[1]!.toLowerCase()
  if (RESERVED_FIRST.has(user) || RESERVED_SECOND.has(track)) return bad('sc_not_a_track')
  return { ok: true, kind: 'track', url: `https://${SC_TRACK_HOST}/${user}/${track}` }
}

// What music-fetch reports as canonicalUrl (always rebuilt from validated
// parts, lower case). The worker accepts nothing else, so the reviewers'
// link can only ever point at a soundcloud.com track page.
export const CANONICAL_URL_RE = /^https:\/\/soundcloud\.com\/[a-z0-9_-]{1,100}\/[a-z0-9_-]{1,100}$/

// music-fetch's result codes (fetch/README.md "Error codes"): the plan §3.6
// contract codes plus its additions (preview_only: fetch 0.2.1 / v0.4.1).
// artwork_host is no longer a job error since fetch 0.2.1 (a warning), and is
// kept for results written before.
export const FETCH_ERROR_CODES = [
  'bad_url',
  'not_a_track',
  'redirect_host',
  'too_large',
  'too_long',
  'timeout',
  'extractor_failed',
  'artwork_host',
  'bad_request',
  'bad_media',
  'interrupted',
  'internal',
  'preview_only',
] as const
export type FetchErrorCode = (typeof FETCH_ERROR_CODES)[number]

// SoundCloud's license ids (the track's "license" field).
export const LICENSE_LABELS: Record<string, string> = {
  'all-rights-reserved': 'All rights reserved',
  'no-rights-reserved': 'No rights reserved',
  'cc-by': 'CC BY',
  'cc-by-sa': 'CC BY-SA',
  'cc-by-nd': 'CC BY-ND',
  'cc-by-nc': 'CC BY-NC',
  'cc-by-nc-sa': 'CC BY-NC-SA',
  'cc-by-nc-nd': 'CC BY-NC-ND',
}

export const LICENSE_RE = /^[a-z0-9-]{1,40}$/

export function licenseLabel(license: string | null | undefined): string | null {
  if (!license || !LICENSE_RE.test(license)) return null
  return LICENSE_LABELS[license] ?? license
}

// "From SoundCloud (CC BY)", shown to the member and to the reviewers.
export function soundcloudLabel(license: string | null | undefined): string {
  const l = licenseLabel(license)
  return l ? `From SoundCloud (${l})` : 'From SoundCloud (license not stated)'
}

// Limits (v0.4.0).
// Per member: at most this many SoundCloud links in any rolling 24 h
// (caps.fetchesPerUserPerDay, admin-lowerable), and this many still being
// fetched or converted at once.
export const FETCHES_PER_USER_PER_DAY = 20
export const FETCH_INFLIGHT_PER_USER = 3
// A link is charged to the staging quota at music-fetch's media cap until
// the fetched file's real size is known (then the MP3's, like a WAV).
export const FETCH_RESERVE_BYTES = 60 * 1024 * 1024
// music-fetch gives up after 10 min of yt-dlp (+ 30 s shortlink, 30 s art):
// with no result 15 min after the request was written, the worker gives up.
export const FETCH_RESULT_TIMEOUT_S = 15 * 60
// A link waits at most this long for its turn (fetch runs one at a time).
export const FETCH_QUEUE_MAX_S = 3 * 3600

// The containers the probe decodes (the formats yt-dlp returns for
// SoundCloud): AAC in MP4 / M4A, Opus in Ogg, MP3. music-fetch's own magic
// check also passes Ogg Vorbis, WAV and FLAC (SoundCloud's "original
// download"), which the portal refuses (sc_codec_unsupported).
export const FETCH_EXT_FORMAT: Record<string, 'mp4' | 'ogg' | 'mp3'> = {
  m4a: 'mp4',
  mp4: 'mp4',
  opus: 'ogg',
  ogg: 'ogg',
  oga: 'ogg',
  mp3: 'mp3',
}
export const FETCH_CODEC: Record<'mp4' | 'ogg' | 'mp3', 'aac' | 'opus' | 'mp3'> = { mp4: 'aac', ogg: 'opus', mp3: 'mp3' }
