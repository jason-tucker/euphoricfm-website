// v0.5.0 events contract (pure): site gate, per-site CSP, paths and the
// playlist-name sanitizer, settings resolution, API/job schemas and the
// env forbidden-key lists both ways. No DB, no network.
import { describe, expect, it } from 'vitest'
import { CreateEventRequest, EventAnnouncementSchema, EventTrackSchema, EventViewSchema, PatchEventRequest, PutPlaylistRequest } from '@/events/contract/api'
import { EVENT_JOB_KINDS, EVENT_JOB_PAYLOADS, eventJobDedupeKey, parseEventJobPayload } from '@/events/contract/jobs'
import {
  annName,
  EVENT_UPLOAD_RE,
  eventUploadPath,
  isEventUploadPathFor,
  isReservedPlaylistName,
  LIBRARY_FILE_RE,
  mainName,
  parseAnyInternalName,
  parseEventUploadPath,
  parseInternalName,
  pinName,
  probeRequestIdForUpload,
  sanitizePlaylistName,
  STINGER_FILE_RE,
} from '@/events/contract/paths'
import { EVENTS_SETTING_DEFAULTS, EventsSettingsPatchSchema, resolveEventsSettings } from '@/events/contract/settings'
import { loadEventsWorkerEnv, loadWebEnv, loadWorkerEnv, portalSite } from '@/server/env'
import { buildCsp } from '@/server/http/csp'
import { siteGate } from '@/server/http/site-gate'

describe('site gate (contract "Site gate")', () => {
  const ev = (p: string) => siteGate('events', p)
  const mu = (p: string) => siteGate('music', p)

  it('events: page paths are rewritten into the app/ev tree', () => {
    expect(ev('/')).toEqual({ kind: 'rewrite', pathname: '/ev' })
    for (const p of ['/calendar', '/how-it-works', '/events/12', '/request', '/my/events/3', '/my/audio', '/staff/settings', '/denied', '/listen']) {
      expect(ev(p)).toEqual({ kind: 'rewrite', pathname: `/ev${p}` })
    }
  })

  it('events: only /api/ev, /api/auth, /api/health and the tus routes pass', () => {
    for (const p of ['/api/ev', '/api/ev/config', '/api/ev/calendar.ics', '/api/ev/events/1/submit', '/api/auth/signin/discord', '/api/auth/callback/discord', '/api/health', '/api/uploads', `/api/uploads/${'a'.repeat(32)}`]) {
      expect(ev(p), p).toEqual({ kind: 'pass' })
    }
    for (const p of [
      '/api/uploads/art',
      '/api/uploads/art/123',
      `/api/uploads/${'A'.repeat(32)}`,
      '/api/uploads/x',
      '/api/batches',
      '/api/batches/1/items',
      '/api/me',
      '/api/admin/settings',
      '/api/media/audio/1',
      '/api/hooks/tickets',
      '/api/health/x',
      '/api/evil',
      '/api/%62atches',
      '/api/ev/../batches',
      '/api/ev/..%2Fbatches',
      '/api/ev/%2e%2e/batches',
      '/api/ev/x%5C..%5Cbatches',
    ]) {
      expect(ev(p), p).toEqual({ kind: 'not_found', api: true })
    }
  })

  it('events: /ev/** asked for directly is a 404 page; static files pass', () => {
    for (const p of ['/ev', '/ev/', '/ev/calendar', '/%65v/calendar']) expect(ev(p), p).toEqual({ kind: 'not_found', api: false })
    for (const p of ['/_next/static/x.js', '/favicon.svg', '/fonts/Begaron-Regular.woff2']) expect(ev(p), p).toEqual({ kind: 'pass' })
    expect(ev('/evil')).toEqual({ kind: 'rewrite', pathname: '/ev/evil' })
    expect(ev('/%E0%A4%A')).toEqual({ kind: 'not_found', api: false })
  })

  it('music: /ev/** and /api/ev/** are a 404, everything else passes unchanged', () => {
    expect(mu('/ev')).toEqual({ kind: 'not_found', api: false })
    expect(mu('/ev/calendar')).toEqual({ kind: 'not_found', api: false })
    expect(mu('/%65v/calendar')).toEqual({ kind: 'not_found', api: false })
    expect(mu('/api/ev/config')).toEqual({ kind: 'not_found', api: true })
    expect(mu('/api/%65v/config')).toEqual({ kind: 'not_found', api: true })
    for (const p of ['/', '/submit', '/review', '/denied', '/evil', '/events', '/api/batches', '/api/uploads/art', '/api/me', '/api/health', '/api/hooks/tickets', '/api/evx']) {
      expect(mu(p), p).toEqual({ kind: 'pass' })
    }
  })

  it('portalSite: events only for the exact value', () => {
    expect(portalSite({})).toBe('music')
    expect(portalSite({ PORTAL_SITE: 'events' })).toBe('events')
    expect(portalSite({ PORTAL_SITE: 'Events' })).toBe('music')
  })
})

describe('per-site CSP', () => {
  it('music is unchanged; events adds https://euphoric.fm to media-src and connect-src', () => {
    expect(buildCsp('N')).toBe(buildCsp('N', 'music'))
    expect(buildCsp('N')).toContain(`media-src 'self' blob:;`)
    expect(buildCsp('N')).toContain(`connect-src 'self';`)
    const e = buildCsp('N', 'events')
    expect(e).toContain(`media-src 'self' blob: https://euphoric.fm;`)
    expect(e).toContain(`connect-src 'self' https://euphoric.fm;`)
    expect(e).toContain(`img-src 'self' data: blob: https://cdn.discordapp.com https://euphoric.fm;`)
    expect(e).toContain(`frame-ancestors 'none'`)
  })
})

describe('event paths and playlist names', () => {
  const snow = '123456789012345678'

  it('probeRequestIdForUpload: pinned input → output (web writes, worker reads the same id)', () => {
    // events-web (server/audio.ts) names the probe request with this and the
    // events worker (jobs/audio.ts audio_collect) reads the result with it.
    // Both import this one function; these pins stop the mapping drifting.
    expect(probeRequestIdForUpload('0123456789abcdef0123456789abcdef')).toBe('01234567-89ab-4def-8123-456789abcdef')
    expect(probeRequestIdForUpload('ffffffffffffffffffffffffffffffff')).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
    expect(probeRequestIdForUpload('a'.repeat(32))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    for (const bad of ['', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '../' + 'a'.repeat(29)]) {
      expect(() => probeRequestIdForUpload(bad), bad).toThrow()
    }
  })

  it('builds and parses the one custom-audio path', () => {
    expect(eventUploadPath(snow, 42)).toBe(`Events/Uploads/${snow}/evt-a42.mp3`)
    expect(EVENT_UPLOAD_RE.test(eventUploadPath(snow, 42))).toBe(true)
    expect(parseEventUploadPath(`Events/Uploads/${snow}/evt-a42.mp3`)).toEqual({ discordId: snow, audioId: 42 })
    expect(isEventUploadPathFor(`Events/Uploads/${snow}/evt-a42.mp3`, snow, 42)).toBe(true)
    expect(isEventUploadPathFor(`Events/Uploads/${snow}/evt-a42.mp3`, snow, 43)).toBe(false)
    for (const bad of [['../x', 1], ['12345', 1], [snow, 0], [snow, -1], [snow, 1.5], [snow, Number.NaN]] as const) {
      expect(() => eventUploadPath(bad[0], bad[1])).toThrow()
    }
    for (const p of [`Events/Uploads/${snow}/evt-a0.mp3`, `Events/Uploads/${snow}/../evt-a1.mp3`, `Events/Uploads/${snow}/evt-a1.mp3.mp3`, `events/Uploads/${snow}/evt-a1.mp3`, `Events/Uploads/${snow}/sub/evt-a1.mp3`]) {
      expect(parseEventUploadPath(p), p).toBeNull()
    }
  })

  it('library and stinger regexes are exact', () => {
    expect(LIBRARY_FILE_RE.test('Music/Artists/GRIM/song.mp3')).toBe(true)
    expect(LIBRARY_FILE_RE.test('Music/Artists/GRIM/sub/song.mp3')).toBe(false)
    expect(LIBRARY_FILE_RE.test('Portal-Test/Music/Artists/GRIM/song.mp3')).toBe(false)
    expect(STINGER_FILE_RE.test('EFM Stingers/one.mp3')).toBe(true)
    expect(STINGER_FILE_RE.test('EFM Stingers/a/one.mp3')).toBe(false)
  })

  it('sanitizes public names strictly', () => {
    expect(sanitizePlaylistName("Jake's Grand Opening!")).toBe("Jake's Grand Opening!")
    expect(sanitizePlaylistName('~EVT1 s1')).toBe('EVT1 s1')
    expect(sanitizePlaylistName('  ~~~  hi  ')).toBe('hi')
    expect(sanitizePlaylistName('a/b\\c"d;e`f$g{h}')).toBe('a b c d e f g h')
    expect(sanitizePlaylistName('evil‮gnp')).toBe('evil gnp')
    expect(sanitizePlaylistName('line\nbreak\u0000x')).toBe('line break x')
    expect(sanitizePlaylistName('Ｆｕｌｌ ｗｉｄｔｈ')).toBe('Full width')
    expect(sanitizePlaylistName('Café Noël')).toBe('Cafe Noel')
    expect(sanitizePlaylistName('x'.repeat(100))).toHaveLength(60)
    expect(sanitizePlaylistName('😀🎉')).toBe('')
  })

  it('mainName / pinName / annName', () => {
    expect(mainName({ visibility: 'public', title: 'Club Night' })).toBe('Club Night')
    expect(mainName({ visibility: 'private', title: 'Secret' })).toBe('Private event')
    expect(mainName({ visibility: 'public', title: '~~~' })).toBe('Event')
    expect(mainName({ visibility: 'public', title: '🎉' })).toBe('Event')
    expect(mainName({ visibility: 'public', title: 'x'.repeat(80) }).startsWith('~')).toBe(false)
    // 0.5.2: helper names are ASCII, no '~' (the 2026-09-29 station-14 outage)
    expect(pinName(7, 1)).toBe('EVT7 s1')
    expect(annName(7, 2)).toBe('EVT7 a2')
    expect(() => pinName(0, 1)).toThrow()
    expect(() => annName(1, 0)).toThrow()
    expect(parseInternalName('EVT7 s1')).toEqual({ eventId: 7, role: 'pin', n: 1 })
    expect(parseInternalName('EVT7 a12')).toEqual({ eventId: 7, role: 'announce', n: 12 })
    expect(parseInternalName('EVT7 x1')).toBeNull()
    expect(parseInternalName('evt7 s1')).toBeNull()
    // legacy '~' names are only ever recognised (to supersede them), never current
    expect(parseInternalName('~EVT7 s1')).toBeNull()
    expect(parseAnyInternalName('~EVT7 s1')).toEqual({ eventId: 7, role: 'pin', n: 1, legacy: true })
    expect(parseAnyInternalName('EVT7 a2')).toEqual({ eventId: 7, role: 'announce', n: 2, legacy: false })
    expect(parseAnyInternalName('Club Night')).toBeNull()
  })

  it('titles shaped like a helper name are reserved; a main name never looks like one', () => {
    for (const t of ['EVT1 s1', 'evt12 a3', 'Evt1 S1', '~EVT1 s1', ' EVT1 s1 ', 'EVT1-s1', 'evt1.a2', 'E V T 1 s 1', 'ＥＶＴ１ ｓ１']) {
      expect(isReservedPlaylistName(t), t).toBe(true)
      expect(mainName({ visibility: 'public', title: t }), t).toBe('Event')
    }
    for (const t of ['EVT party', 'Event 1 s1', 'EVT1 s1 afterparty', 'Club Night', 'EVTs 1', 'S1 EVT1']) {
      expect(isReservedPlaylistName(t), t).toBe(false)
    }
    expect(mainName({ visibility: 'public', title: 'EVT1 s1 afterparty' })).toBe('EVT1 s1 afterparty')
  })
})

describe('events settings resolution', () => {
  it('defaults when rows are missing', () => {
    expect(resolveEventsSettings([])).toEqual(EVENTS_SETTING_DEFAULTS)
    expect(EVENTS_SETTING_DEFAULTS.events_enabled).toBe(false)
    expect(EVENTS_SETTING_DEFAULTS.events_staging_budget_bytes).toBe(1610612736)
  })

  it('valid rows win; invalid rows and foreign keys are ignored', () => {
    const s = resolveEventsSettings([
      { key: 'events_enabled', value: true },
      { key: 'events_min_notice_h', value: 12 },
      { key: 'events_gap_min', value: 'ten' },
      { key: 'events_max_rows', value: 10_000 },
      { key: 'events_pin_strategy', value: 'split_main' },
      { key: 'events_announce_strategy', value: 'nope' },
      { key: 'caps', value: { maxStagingBytes: 1 } },
    ])
    expect(s.events_enabled).toBe(true)
    expect(s.events_min_notice_h).toBe(12)
    expect(s.events_gap_min).toBe(10)
    expect(s.events_max_rows).toBe(150)
    expect(s.events_pin_strategy).toBe('split_main')
    expect(s.events_announce_strategy).toBe('interrupt_rows')
    expect(resolveEventsSettings({ events_uploads_enabled: true }).events_uploads_enabled).toBe(true)
  })

  it('warn threshold is never below the minimum notice', () => {
    expect(resolveEventsSettings([{ key: 'events_min_notice_h', value: 72 }]).events_warn_notice_h).toBe(72)
  })

  it('the patch schema is strict and non-empty', () => {
    expect(EventsSettingsPatchSchema.safeParse({ events_enabled: true }).success).toBe(true)
    expect(EventsSettingsPatchSchema.safeParse({}).success).toBe(false)
    expect(EventsSettingsPatchSchema.safeParse({ caps: {} }).success).toBe(false)
    expect(EventsSettingsPatchSchema.safeParse({ events_staging_budget_bytes: 6 * 1024 ** 3 }).success).toBe(false)
  })
})

describe('API and job schemas', () => {
  const create = {
    title: '  Grand Opening  ',
    hostName: '',
    description: 'Line one\nLine two',
    location: null,
    eventType: 'grand_opening',
    startsAt: '2026-10-10T20:00:00-04:00',
    endsAt: '2026-10-11T02:00:00Z',
    enteredTz: 'America/New_York',
    visibility: 'public',
    playlistOrder: 'shuffle',
  }

  it('create: trims, nulls empty optionals, refuses end ≤ start and unknown keys', () => {
    const r = CreateEventRequest.parse(create)
    expect(r.title).toBe('Grand Opening')
    expect(r.hostName).toBeNull()
    expect(r.description).toBe('Line one\nLine two')
    expect(CreateEventRequest.safeParse({ ...create, endsAt: create.startsAt }).success).toBe(false)
    expect(CreateEventRequest.safeParse({ ...create, extra: 1 }).success).toBe(false)
    expect(CreateEventRequest.safeParse({ ...create, title: 'x'.repeat(81) }).success).toBe(false)
    expect(CreateEventRequest.safeParse({ ...create, title: 'a‮b' }).success).toBe(false)
    expect(CreateEventRequest.safeParse({ ...create, startsAt: '2026-10-10 20:00' }).success).toBe(false)
    expect(PatchEventRequest.safeParse({ title: 'New' }).success).toBe(true)
    expect(PatchEventRequest.safeParse({ version: 2 }).success).toBe(false)
  })

  it('tracks and announcements: source and mode shapes', () => {
    expect(EventTrackSchema.safeParse({ position: 0, source: 'library', mediaId: 5, audioId: null, pinAt: null }).success).toBe(true)
    expect(EventTrackSchema.safeParse({ position: 0, source: 'library', mediaId: null, audioId: 5, pinAt: null }).success).toBe(false)
    expect(EventTrackSchema.safeParse({ position: 0, source: 'upload', mediaId: null, audioId: 5, pinAt: '2026-10-10T21:00:00Z' }).success).toBe(true)
    const at = { source: 'stinger', mediaId: 9, audioId: null, mode: 'at', at: '2026-10-10T21:00:00Z', everyMin: null, from: null, until: null }
    expect(EventAnnouncementSchema.safeParse(at).success).toBe(true)
    expect(EventAnnouncementSchema.safeParse({ ...at, everyMin: 15 }).success).toBe(false)
    const every = { ...at, mode: 'every', at: null, everyMin: 30, from: '2026-10-10T21:00:00Z', until: '2026-10-10T23:00:00Z' }
    expect(EventAnnouncementSchema.safeParse(every).success).toBe(true)
    expect(EventAnnouncementSchema.safeParse({ ...every, everyMin: 25 }).success).toBe(false)
    expect(EventAnnouncementSchema.safeParse({ ...every, until: every.from }).success).toBe(false)
    const t = { position: 0, source: 'library', mediaId: 5, audioId: null, pinAt: null }
    expect(PutPlaylistRequest.safeParse({ tracks: [t, t], announcements: [], playlistOrder: 'sequential' }).success).toBe(false)
  })

  it('views: private and pending projections carry no details', () => {
    const b = { id: 1, startsAt: '2026-10-10T20:00:00Z', endsAt: '2026-10-10T22:00:00Z' }
    expect(EventViewSchema.safeParse({ kind: 'private', ...b, status: 'approved', label: 'Booked · Private event' }).success).toBe(true)
    expect(EventViewSchema.safeParse({ kind: 'pending', ...b, status: 'pending', label: 'Pending' }).success).toBe(true)
    expect(EventViewSchema.safeParse({ kind: 'private', ...b, status: 'draft', label: 'Booked · Private event' }).success).toBe(false)
    const priv = EventViewSchema.parse({ kind: 'private', ...b, status: 'live', label: 'Booked · Private event', title: 'leak' })
    expect('title' in priv).toBe(false)
  })

  it('jobs: every kind has a strict payload; dedupe keys', () => {
    for (const k of EVENT_JOB_KINDS) expect(EVENT_JOB_PAYLOADS[k]).toBeDefined()
    expect(parseEventJobPayload('build', { eventId: 3, version: 2 })).toEqual({ eventId: 3, version: 2 })
    expect(() => parseEventJobPayload('build', { eventId: 3 })).toThrow()
    expect(() => parseEventJobPayload('teardown', { eventId: 3, extra: 1 })).toThrow()
    expect(eventJobDedupeKey('build', { eventId: 3, version: 2 })).toBe('build:3:2')
    expect(eventJobDedupeKey('start_kick', { eventId: 3 }, 4)).toBe('start_kick:3:4')
    expect(eventJobDedupeKey('verify', { eventId: 3, buildId: 9 })).toBe('verify:3:b9')
    expect(eventJobDedupeKey('audio_ingest', { audioId: 5 })).toBe('audio_ingest:a5')
    expect(eventJobDedupeKey('ticket_post', { eventId: 3, kind: 'approved', body: 'ok', idem: 'approved:3:2' })).toBe('ticket_post:approved:3:2')
    expect(eventJobDedupeKey('stinger_sync', {}, '2026-09-29T06')).toBe('stinger_sync:2026-09-29T06')
  })
})

describe('env forbidden keys both ways (v0.5.0)', () => {
  const web = {
    DATABASE_URL: 'postgres://x', AUTH_SECRET: 'a'.repeat(40), AUTH_DISCORD_ID: 'i', AUTH_DISCORD_SECRET: 's',
    APP_ENC_KEY: '0'.repeat(64), TICKETS_WEBHOOK_SECRET: 'w'.repeat(40), AUTH_URL: 'https://music.euphoric.fm',
  }
  const evWeb = { ...web, PORTAL_SITE: 'events', PORTAL_ORIGIN: 'https://events.euphoric.fm', AUTH_URL: 'https://events.euphoric.fm' }
  const worker = { DATABASE_URL: 'postgres://x', AZURACAST_API_KEY: 'k'.repeat(20), TICKETS_WRITE_KEY: 't' }
  const evWorker = { DATABASE_URL: 'postgres://x', EVENTS_AZURACAST_API_KEY: 'e'.repeat(20), EVENTS_STATION_ID: '14', EVENTS_TICKETS_WRITE_KEY: 'et' }

  it('web: PORTAL_SITE defaults to music and only takes music|events', () => {
    expect(loadWebEnv(web).PORTAL_SITE).toBe('music')
    expect(loadWebEnv(evWeb).PORTAL_SITE).toBe('events')
    expect(() => loadWebEnv({ ...web, PORTAL_SITE: 'event' })).toThrow()
  })

  it('music web and music worker refuse any EVENTS_* key', () => {
    for (const k of ['EVENTS_AZURACAST_API_KEY', 'EVENTS_TICKETS_WRITE_KEY', 'EVENTS_STATION_ID']) {
      expect(() => loadWebEnv({ ...web, [k]: 'x' }), k).toThrow(/another service/)
      expect(() => loadWorkerEnv({ ...worker, [k]: 'x' }), k).toThrow(/another service/)
    }
    expect(() => loadWebEnv({ ...web, EVENTS_AZURACAST_API_KEY: '' })).not.toThrow()
  })

  it('events web refuses every AzuraCast and tickets write key', () => {
    expect(() => loadWebEnv(evWeb)).not.toThrow()
    for (const k of ['AZURACAST_API_KEY', 'TICKETS_WRITE_KEY', 'EVENTS_AZURACAST_API_KEY', 'EVENTS_TICKETS_WRITE_KEY', 'DATABASE_OWNER_URL']) {
      expect(() => loadWebEnv({ ...evWeb, [k]: 'x' }), k).toThrow(/another service/)
    }
  })

  it('events worker: station 14 only, own keys only, canaries parsed', () => {
    const e = loadEventsWorkerEnv(evWorker)
    expect(e.EVENTS_CANARY_STATION_IDS).toEqual([7]) // one AzuraCast account: station 1 is readable
    expect(loadEventsWorkerEnv({ ...evWorker, EVENTS_CANARY_STATION_IDS: '1,7' }).EVENTS_CANARY_STATION_IDS).toEqual([1, 7])
    expect(e.PORTAL_ORIGIN).toBe('https://events.euphoric.fm')
    expect(e.AZURACAST_BASE_URL).toBe('https://euphoric.fm')
    expect(() => loadEventsWorkerEnv({ ...evWorker, EVENTS_STATION_ID: '1' })).toThrow()
    expect(() => loadEventsWorkerEnv({ ...evWorker, EVENTS_STATION_ID: undefined })).toThrow()
    expect(() => loadEventsWorkerEnv({ ...evWorker, EVENTS_CANARY_STATION_IDS: '1,14' })).toThrow()
    expect(() => loadEventsWorkerEnv({ ...evWorker, EVENTS_CANARY_STATION_IDS: 'x' })).toThrow()
    expect(() => loadEventsWorkerEnv({ ...evWorker, AZURACAST_BASE_URL: 'https://euphoric.fm/x' })).toThrow(/bare origin/)
    expect(() => loadEventsWorkerEnv({ ...evWorker, AZURACAST_BASE_URL: 'http://az' })).toThrow(/https/)
    // the optional alert webhook, as on the music worker
    expect(e.ALERT_DISCORD_WEBHOOK).toBeUndefined()
    expect(loadEventsWorkerEnv({ ...evWorker, ALERT_DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/1/x' }).ALERT_DISCORD_WEBHOOK).toBe('https://discord.com/api/webhooks/1/x')
    expect(() => loadEventsWorkerEnv({ ...evWorker, ALERT_DISCORD_WEBHOOK: 'not a url' })).toThrow()
    for (const k of ['AZURACAST_API_KEY', 'TICKETS_WRITE_KEY', 'AUTH_SECRET', 'APP_ENC_KEY', 'TICKETS_WEBHOOK_SECRET', 'DATABASE_OWNER_URL']) {
      expect(() => loadEventsWorkerEnv({ ...evWorker, [k]: 'x' }), k).toThrow(/another service/)
    }
  })
})
