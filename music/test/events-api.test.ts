// v0.5.0 events API (workstream A): pure unit tests for the booking rules,
// the state machine, the privacy projection (every surface), the ICS feed
// and the ticket copy. No DB (see events-api-db.test.ts for the flows).
import { describe, expect, it } from 'vitest'
import { EVENTS_SETTING_DEFAULTS, type EventsSettings } from '@/events/contract/settings'
import type { EventAnnouncement, EventStatus, EventTrack } from '@/events/contract/types'
import { EventMutationResponse, EventViewSchema, FullEventViewSchema, PutPlaylistRequest } from '@/events/contract/api'
import { probeRequestIdForUpload } from '@/events/contract/paths'
import { compile, CompileError } from '@/events/azuracast/compiler'
import { pinWindow } from '@/events/azuracast/windows'
import { buildIcs, foldLine, icsText, icsUid } from '@/events/server/ics'
import {
  assertEditable,
  assertSubmittable,
  canEdit,
  changedFields,
  checkClash,
  checkTiming,
  estimateRows,
  needsReapproval,
  occurrences,
  playlistKey,
  validatePlaylist,
  type Actor,
  type AudioInfo,
  type LibraryInfo,
  type Lookup,
} from '@/events/server/rules'
import { jobsFor, nextStatus, TRANSITIONS } from '@/events/server/state'
import { diffLines, editedBody, type DiffSide } from '@/events/server/tickets-outbound'
import { etDatesSpanned, onGrid, overlapsNightlyRestart } from '@/events/server/time'
import { fullView, publicView, viewEvent, type EventRecord, type FullExtras } from '@/events/server/view'
import * as svc from '@/events/server/service'
import { EVENT_STATUS } from '@/events/components/labels'

const H = 3600_000
const M = 60_000
const S: EventsSettings = { ...EVENTS_SETTING_DEFAULTS, events_enabled: true }
// 2026-10-01 12:00 UTC (08:00 EDT)
const NOW = Date.UTC(2026, 9, 1, 12, 0)

const member = (id = 'u-owner', discordId = '100000000000000001'): Actor => ({ userId: id, discordId, name: 'Owner', staff: false, manage: false })
const OWNER = member()
const OTHER = member('u-other', '100000000000000002')
const STAFF: Actor = { userId: 'u-staff', discordId: '100000000000000003', name: 'Staff', staff: true, manage: false }

/** An ET wall time on 2026-10-0x (EDT, UTC−4). */
const et = (day: number, hh: number, mm = 0) => Date.UTC(2026, 9, day, hh + 4, mm)
const iso = (t: number) => new Date(t).toISOString()

function record(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 42,
    ownerUserId: OWNER.userId,
    ownerDiscordId: OWNER.discordId,
    title: 'Secret Party Title',
    hostName: 'Secret Host',
    description: 'Secret description',
    location: 'Secret Location',
    eventType: 'club_night',
    startsAt: new Date(et(5, 20)),
    endsAt: new Date(et(5, 23)),
    visibility: 'public',
    status: 'approved',
    shortNotice: false,
    playlistOrder: 'shuffle',
    ticketNumber: 7,
    ticketUrl: 'https://tickets.example/t/7',
    denyReason: null,
    version: 3,
    ...over,
  }
}

function lookup(over: { library?: LibraryInfo[]; audio?: AudioInfo[]; stingers?: { mediaId: number; title: string; lengthS: number }[] } = {}): Lookup {
  const lib = over.library ?? [
    { mediaId: 101, path: 'Music/Artists/A/one.mp3', title: 'One', artist: 'A', lengthS: 200, archived: false },
    { mediaId: 102, path: 'Music/Artists/B/two.mp3', title: 'Two', artist: 'B', lengthS: 180, archived: false },
  ]
  const audio = over.audio ?? [
    { id: 501, ownerUserId: OWNER.userId, kind: 'song', status: 'live', deletedAt: null, title: 'My Mix', artist: 'Me', durationS: 600 },
    { id: 502, ownerUserId: OWNER.userId, kind: 'announcement', status: 'ready', deletedAt: null, title: 'Welcome', artist: null, durationS: 20 },
    { id: 601, ownerUserId: OTHER.userId, kind: 'song', status: 'live', deletedAt: null, title: 'Not yours', artist: 'X', durationS: 300 },
    { id: 503, ownerUserId: OWNER.userId, kind: 'song', status: 'probing', deletedAt: null, title: 'Probing', artist: 'Me', durationS: null },
    { id: 504, ownerUserId: OWNER.userId, kind: 'song', status: 'live', deletedAt: new Date(), title: 'Deleted', artist: 'Me', durationS: 100 },
  ]
  const st = over.stingers ?? [{ mediaId: 900, title: 'EFM ID', lengthS: 12 }]
  return {
    library: new Map(lib.map((l) => [l.mediaId, l])),
    audio: new Map(audio.map((a) => [a.id, a])),
    stingers: new Map(st.map((s) => [s.mediaId, s])),
  }
}

const lib = (position: number, mediaId: number, pinAt: string | null = null): EventTrack => ({ position, source: 'library', mediaId, audioId: null, pinAt })
const up = (position: number, audioId: number, pinAt: string | null = null): EventTrack => ({ position, source: 'upload', mediaId: null, audioId, pinAt })
const at = (t: number, over: Partial<EventAnnouncement> = {}): EventAnnouncement => ({ source: 'stinger', mediaId: 900, audioId: null, mode: 'at', at: iso(t), everyMin: null, from: null, until: null, ...over })
const every = (from: number, until: number, everyMin: 15 | 20 | 30 | 60, over: Partial<EventAnnouncement> = {}): EventAnnouncement => ({
  source: 'stinger',
  mediaId: 900,
  audioId: null,
  mode: 'every',
  at: null,
  everyMin,
  from: iso(from),
  until: iso(until),
  ...over,
})

const EV = { startsAt: new Date(et(5, 20)), endsAt: new Date(et(5, 23)), ownerUserId: OWNER.userId }
const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code
  }
  return 'ok'
}

// ------------------------------------------------------------ time ------

describe('events time helpers (ET wall clock)', () => {
  it('5-minute grid', () => {
    expect(onGrid(et(5, 20, 5))).toBe(true)
    expect(onGrid(et(5, 20, 7))).toBe(false)
    expect(onGrid(et(5, 20, 5) + 1000)).toBe(false)
  })
  it('nightly restart band 01:55–02:05 ET (half-open windows)', () => {
    expect(overlapsNightlyRestart(et(6, 1, 50), et(6, 2, 0))).toBe(true)
    expect(overlapsNightlyRestart(et(6, 1, 40), et(6, 1, 55))).toBe(false)
    expect(overlapsNightlyRestart(et(6, 2, 5), et(6, 2, 20))).toBe(false)
    expect(overlapsNightlyRestart(et(6, 2, 4), et(6, 2, 10))).toBe(true)
    expect(overlapsNightlyRestart(et(5, 20), et(5, 20, 15))).toBe(false)
  })
  it('fall-back day: the repeated 1 AM hour is unsafe; spring-forward band still refused', () => {
    // 2026-11-01: 01:30 EDT = 05:30 UTC, 01:30 EST = 06:30 UTC
    expect(overlapsNightlyRestart(Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 5, 40))).toBe(true)
    expect(overlapsNightlyRestart(Date.UTC(2026, 10, 1, 6, 30), Date.UTC(2026, 10, 1, 6, 40))).toBe(true)
    // a normal night's 01:30 is fine
    expect(overlapsNightlyRestart(et(6, 1, 30), et(6, 1, 40))).toBe(false)
    // 2026-03-08: 01:55 EST = 06:55 UTC, then 03:00 EDT
    expect(overlapsNightlyRestart(Date.UTC(2026, 2, 8, 6, 50), Date.UTC(2026, 2, 8, 7, 5))).toBe(true)
  })
  it('counts ET dates, not UTC dates', () => {
    expect(etDatesSpanned(et(5, 20), et(5, 23, 59))).toBe(1) // 03:59 UTC next day
    expect(etDatesSpanned(et(5, 22), et(6, 2))).toBe(2)
    expect(etDatesSpanned(et(5, 20), et(6, 0))).toBe(1) // ends exactly at midnight
  })
})

// ------------------------------------------------------------ timing ----

describe('checkTiming (notice / length / horizon)', () => {
  it('member: too_soon under min notice, short_notice under warn notice', () => {
    expect(code(() => checkTiming({ startsAt: NOW + 23 * H, endsAt: NOW + 25 * H }, OWNER, S, NOW))).toBe('too_soon')
    expect(checkTiming({ startsAt: NOW + 30 * H, endsAt: NOW + 32 * H }, OWNER, S, NOW)).toEqual({ shortNotice: true })
    expect(checkTiming({ startsAt: NOW + 50 * H, endsAt: NOW + 52 * H }, OWNER, S, NOW)).toEqual({ shortNotice: false })
  })
  it('member: too_long, too_far, bad_range', () => {
    expect(code(() => checkTiming({ startsAt: NOW + 50 * H, endsAt: NOW + 75 * H }, OWNER, S, NOW))).toBe('too_long')
    expect(code(() => checkTiming({ startsAt: NOW + 181 * 24 * H, endsAt: NOW + 181 * 24 * H + H }, OWNER, S, NOW))).toBe('too_far')
    expect(code(() => checkTiming({ startsAt: NOW + 50 * H, endsAt: NOW + 50 * H }, OWNER, S, NOW))).toBe('bad_range')
  })
  it('staff are exempt from notice/length/horizon but not from the past', () => {
    expect(checkTiming({ startsAt: NOW + H, endsAt: NOW + 40 * H }, STAFF, S, NOW)).toEqual({ shortNotice: true })
    expect(code(() => checkTiming({ startsAt: NOW - 2 * H, endsAt: NOW - H }, STAFF, S, NOW))).toBe('bad_range')
  })
  it('a boundary in the repeated fall-back hour is refused', () => {
    const t = Date.UTC(2026, 10, 1, 5, 30)
    expect(code(() => checkTiming({ startsAt: t, endsAt: t + 2 * H }, STAFF, S, t - 100 * H))).toBe('nightly_restart')
  })
})

// ------------------------------------------------------------ clashes ---

describe('checkClash (overlap + gap; staff may book adjacent)', () => {
  const other = { id: 7, startsAt: new Date(et(5, 18)), endsAt: new Date(et(5, 20)), status: 'approved' as EventStatus }
  it('overlap is refused for everyone', () => {
    expect(code(() => checkClash({ startsAt: et(5, 19), endsAt: et(5, 21) }, [other], 10, OWNER))).toBe('overlap')
    expect(code(() => checkClash({ startsAt: et(5, 19), endsAt: et(5, 21) }, [other], 10, STAFF))).toBe('overlap')
  })
  it('inside the gap: members refused, staff allowed and told it is adjacent', () => {
    expect(code(() => checkClash({ startsAt: et(5, 20, 5), endsAt: et(5, 22) }, [other], 10, OWNER))).toBe('overlap')
    expect(checkClash({ startsAt: et(5, 20), endsAt: et(5, 22) }, [other], 10, STAFF)).toEqual({ adjacent: [7] })
    expect(checkClash({ startsAt: et(5, 20, 10), endsAt: et(5, 22) }, [other], 10, OWNER)).toEqual({ adjacent: [] })
  })
  it('ignores itself and statuses that do not hold a slot', () => {
    expect(checkClash({ id: 7, startsAt: et(5, 19), endsAt: et(5, 21) }, [other], 10, OWNER)).toEqual({ adjacent: [] })
    for (const status of ['draft', 'denied', 'withdrawn', 'cancelled', 'expired', 'failed', 'ended'] as EventStatus[]) {
      expect(checkClash({ startsAt: et(5, 19), endsAt: et(5, 21) }, [{ ...other, status }], 10, OWNER)).toEqual({ adjacent: [] })
    }
    // pending holds its slot
    expect(code(() => checkClash({ startsAt: et(5, 19), endsAt: et(5, 21) }, [{ ...other, status: 'pending' }], 10, OWNER))).toBe('overlap')
  })
})

// ------------------------------------------------------------ freeze ----

describe('freeze and editability', () => {
  const ev = { id: 1, ownerUserId: OWNER.userId, status: 'approved' as EventStatus, startsAt: new Date(NOW + 20 * M), endsAt: new Date(NOW + 3 * H), visibility: 'public' as const, playlistOrder: 'shuffle' as const, version: 1 }
  it('members are frozen 30 min before start; staff can still edit', () => {
    expect(code(() => assertEditable(ev, OWNER, S, NOW))).toBe('frozen')
    expect(code(() => assertEditable(ev, STAFF, S, NOW))).toBe('ok')
    expect(canEdit(ev, OWNER, S, NOW)).toBe(false)
    expect(canEdit(ev, STAFF, S, NOW)).toBe(true)
    expect(canEdit({ ...ev, startsAt: new Date(NOW + 2 * H) }, OWNER, S, NOW)).toBe(true)
    expect(canEdit({ ...ev, startsAt: new Date(NOW + 2 * H) }, OTHER, S, NOW)).toBe(false)
  })
  it('live: staff only; terminal: nobody', () => {
    expect(code(() => assertEditable({ ...ev, status: 'live' }, OWNER, S, NOW))).toBe('not_editable')
    expect(code(() => assertEditable({ ...ev, status: 'live' }, STAFF, S, NOW))).toBe('ok')
    for (const status of ['ended', 'denied', 'withdrawn', 'cancelled', 'expired', 'failed'] as EventStatus[]) {
      expect(code(() => assertEditable({ ...ev, status, startsAt: new Date(NOW + 5 * H), endsAt: new Date(NOW + 6 * H) }, STAFF, S, NOW))).toBe('not_editable')
    }
  })
})

// ------------------------------------------------------------ playlist --

describe('validatePlaylist', () => {
  const ok = (tracks: EventTrack[], announcements: EventAnnouncement[] = [], actor: Actor = OWNER, lk = lookup()) =>
    code(() => validatePlaylist(EV, { tracks, announcements }, lk, S, actor))

  it('accepts library songs, own ready/live uploads and stingers', () => {
    expect(ok([lib(0, 101), lib(1, 102), up(2, 501)], [at(et(5, 21)), { ...at(et(5, 22)), source: 'upload', mediaId: null, audioId: 502 }])).toBe('ok')
  })
  it('refuses duplicate songs', () => {
    expect(ok([lib(0, 101), lib(1, 101)])).toBe('duplicate_track')
    expect(ok([up(0, 501), up(1, 501)])).toBe('duplicate_track')
  })
  it('library ids must be on Music/Artists/<a>/<file>, cached and not archived', () => {
    expect(ok([lib(0, 999)])).toBe('media_not_allowed')
    const lk = lookup({ library: [{ mediaId: 101, path: 'Events/Uploads/1/x.mp3', title: 'x', artist: null, lengthS: 1, archived: false }] })
    expect(ok([lib(0, 101)], [], OWNER, lk)).toBe('media_not_allowed')
    const nested = lookup({ library: [{ mediaId: 101, path: 'Music/Artists/A/B/x.mp3', title: 'x', artist: null, lengthS: 1, archived: false }] })
    expect(ok([lib(0, 101)], [], OWNER, nested)).toBe('media_not_allowed')
    const archived = lookup({ library: [{ mediaId: 101, path: 'Music/Artists/A/one.mp3', title: 'x', artist: null, lengthS: 1, archived: true }] })
    expect(ok([lib(0, 101)], [], OWNER, archived)).toBe('media_not_allowed')
  })
  it("another member's audio is refused exactly like a missing id (even for staff editing the event)", () => {
    expect(ok([up(0, 601)])).toBe('media_not_allowed')
    expect(ok([up(0, 601)], [], STAFF)).toBe('media_not_allowed')
    expect(ok([lib(0, 101)], [{ ...at(et(5, 21)), source: 'upload', mediaId: null, audioId: 601 }])).toBe('media_not_allowed')
    expect(ok([up(0, 77777)])).toBe('media_not_allowed')
    expect(ok([up(0, 504)])).toBe('media_not_allowed') // deleted
    expect(ok([up(0, 503)])).toBe('audio_not_ready') // probing
  })
  it('stingers must be in event_stingers', () => {
    expect(ok([lib(0, 101)], [at(et(5, 21), { mediaId: 12345 })])).toBe('media_not_allowed')
  })
  it('pins: 5-min grid, inside the event, at most end − 15 min', () => {
    expect(ok([lib(0, 101), lib(1, 102, iso(et(5, 21, 30)))])).toBe('ok')
    expect(ok([lib(0, 101), lib(1, 102, iso(et(5, 22, 45)))])).toBe('ok')
    expect(ok([lib(0, 101), lib(1, 102, iso(et(5, 22, 50)))])).toBe('pin_out_of_range')
    expect(ok([lib(0, 101), lib(1, 102, iso(et(5, 21, 32)))])).toBe('pin_out_of_range')
    expect(ok([lib(0, 101), lib(1, 102, iso(et(5, 19, 55)))])).toBe('pin_out_of_range')
  })
  it('pins and announcements touching 01:55–02:05 ET are refused', () => {
    const late = { ...EV, startsAt: new Date(et(6, 0)), endsAt: new Date(et(6, 4)) }
    expect(code(() => validatePlaylist(late, { tracks: [lib(0, 101), lib(1, 102, iso(et(6, 1, 45)))], announcements: [] }, lookup(), S, OWNER))).toBe('nightly_restart')
    expect(code(() => validatePlaylist(late, { tracks: [lib(0, 101)], announcements: [at(et(6, 1, 55))] }, lookup(), S, OWNER))).toBe('nightly_restart')
    expect(code(() => validatePlaylist(late, { tracks: [lib(0, 101)], announcements: [at(et(6, 2, 5))] }, lookup(), S, OWNER))).toBe('ok')
    // every: one occurrence lands in the band
    expect(code(() => validatePlaylist(late, { tracks: [lib(0, 101)], announcements: [every(et(6, 0), et(6, 3), 30)] }, lookup(), S, OWNER))).toBe('nightly_restart')
  })
  it('mirrors the compiler (shared azuracast/windows.ts): fall-back hour and sub-minute pin rows', () => {
    const fb = { ...EV, startsAt: new Date('2026-10-31T22:00:00-04:00'), endsAt: new Date('2026-11-01T04:00:00-05:00') }
    // a pin at 00:45 EDT: its window 00:45–01:00 ends on the repeated hour
    expect(code(() => validatePlaylist(fb, { tracks: [lib(0, 101), lib(1, 102, '2026-11-01T04:45:00.000Z')], announcements: [] }, lookup(), S, OWNER))).toBe('nightly_restart')
    expect(code(() => validatePlaylist(fb, { tracks: [lib(0, 101), lib(1, 102, '2026-11-01T04:40:00.000Z')], announcements: [] }, lookup(), S, OWNER))).toBe('ok')
    // a 4-minute announcement at 00:55 EDT: 00:55 + 4 min + 1 min tail ends at 01:00
    const long = lookup({ stingers: [{ mediaId: 900, title: 'Long', lengthS: 240 }] })
    expect(code(() => validatePlaylist(fb, { tracks: [lib(0, 101)], announcements: [at(Date.parse('2026-11-01T04:55:00.000Z'))] }, long, S, OWNER))).toBe('nightly_restart')
    // a pin at 23:59 (off the grid for the server anyway): its row truncated at 23:59 is empty
    expect(pinWindow(Date.parse('2026-10-10T23:59:00-04:00'), Date.parse('2026-10-11T01:00:00-04:00')).refusal).toBe('row_too_short')
    expect(pinWindow(Date.parse('2026-10-10T23:55:00-04:00'), Date.parse('2026-10-11T01:00:00-04:00')).refusal).toBeNull()
    // every grid instant of the fall-back night: the server accepts a pin / an
    // announcement exactly when the compiler does
    const compiles = (tracks: { position: number; mediaId: number; pinAt: Date | null }[], anns: { mediaId: number; durationS: number; mode: 'at'; at: Date; everyMin: null; from: null; until: null }[]) => {
      try {
        compile({
          event: { id: 42, version: 1, startsAt: fb.startsAt, endsAt: fb.endsAt, mainName: 'Grand Opening', playlistOrder: 'shuffle' },
          tracks,
          announcements: anns,
          settings: { maxRows: 500, pinStrategy: 'overlap', announceStrategy: 'interrupt_rows' },
          now: new Date('2026-09-29T12:00:00Z'),
        })
        return 'ok'
      } catch (e) {
        if (e instanceof CompileError) return e.code
        throw e
      }
    }
    let checked = 0
    for (let t = fb.startsAt.getTime(); t < fb.endsAt.getTime(); t += 5 * 60_000) {
      const server = code(() => validatePlaylist(fb, { tracks: [lib(0, 101), lib(1, 102, iso(t))], announcements: [] }, lookup(), S, OWNER))
      const compiler = compiles([{ position: 0, mediaId: 101, pinAt: null }, { position: 1, mediaId: 102, pinAt: new Date(t) }], [])
      expect(server === 'ok', `pin ${iso(t)}: server ${server}, compiler ${compiler}`).toBe(compiler === 'ok')
      const sa = code(() => validatePlaylist(fb, { tracks: [lib(0, 101)], announcements: [at(t)] }, long, S, OWNER))
      const ca = compiles([{ position: 0, mediaId: 101, pinAt: null }], [{ mediaId: 900, durationS: 240, mode: 'at', at: new Date(t), everyMin: null, from: null, until: null }])
      expect(sa === 'ok', `announcement ${iso(t)}: server ${sa}, compiler ${ca}`).toBe(ca === 'ok')
      checked++
    }
    expect(checked).toBe(84) // 7 wall hours: 22:00–04:00 with 01:00 twice
  })
  it('announcements: grid, inside the event, finishing before the end, no overlaps', () => {
    expect(ok([lib(0, 101)], [at(et(5, 21, 3))])).toBe('bad_announcement')
    expect(ok([lib(0, 101)], [at(et(5, 23))])).toBe('bad_announcement')
    expect(ok([lib(0, 101)], [at(et(5, 19))])).toBe('bad_announcement')
    // 600 s upload at 22:55 runs past 23:00
    expect(ok([lib(0, 101)], [{ ...at(et(5, 22, 55)), source: 'upload', mediaId: null, audioId: 501 }])).toBe('bad_announcement')
    expect(ok([lib(0, 101)], [at(et(5, 21)), at(et(5, 21))])).toBe('bad_announcement')
    expect(ok([lib(0, 101)], [every(et(5, 20), et(5, 23), 30)])).toBe('ok')
    expect(ok([lib(0, 101)], [every(et(5, 20), et(5, 23, 30), 30)])).toBe('bad_announcement')
  })
  it('row cap applies to members; staff may override', () => {
    const tight = { ...S, events_max_rows: 5 }
    const p = { tracks: [lib(0, 101)], announcements: [every(et(5, 20), et(5, 23), 15)] } // 1 + 12 rows
    expect(code(() => validatePlaylist(EV, p, lookup(), tight, OWNER))).toBe('too_many_rows')
    expect(validatePlaylist(EV, p, lookup(), tight, STAFF)).toEqual({ rows: 13 })
  })
  it('structuralOnly (a draft autosave): ids and duplicates still refused, timing rules deferred to submit', () => {
    const draft = (tracks: EventTrack[], announcements: EventAnnouncement[] = [], s = S) =>
      code(() => validatePlaylist(EV, { tracks, announcements }, lookup(), s, OWNER, { structuralOnly: true }))
    // structural refusals are the same as the full check
    expect(draft([lib(0, 101), lib(1, 101)])).toBe('duplicate_track')
    expect(draft([lib(0, 999)])).toBe('media_not_allowed')
    expect(draft([up(0, 601)])).toBe('media_not_allowed')
    expect(draft([up(0, 503)])).toBe('audio_not_ready')
    expect(draft([lib(0, 101)], [at(et(5, 21), { mediaId: 12345 })])).toBe('media_not_allowed')
    // timing problems are stored for a draft (the full check still refuses them)
    const offGridPin = [lib(0, 101), lib(1, 102, iso(et(5, 22, 50)))]
    expect(draft(offGridPin)).toBe('ok')
    expect(ok(offGridPin)).toBe('pin_out_of_range')
    const outside = [at(et(5, 23)), at(et(5, 21)), at(et(5, 21))]
    expect(draft([lib(0, 101)], outside)).toBe('ok')
    expect(ok([lib(0, 101)], outside)).toBe('bad_announcement')
    const tight = { ...S, events_max_rows: 5 }
    expect(draft([lib(0, 101)], [every(et(5, 20), et(5, 23), 15)], tight)).toBe('ok')
    // an empty playlist is a valid draft too
    expect(draft([])).toBe('ok')
  })
  it('estimateRows: main per ET date + pins (+split_main) + occurrences', () => {
    const overnight = { startsAt: new Date(et(5, 22)), endsAt: new Date(et(6, 1)) }
    const p = { tracks: [lib(0, 101), lib(1, 102, iso(et(5, 23)))], announcements: [every(et(5, 22), et(5, 23), 20)] }
    expect(estimateRows(overnight, p, S)).toBe(2 + 1 + 3)
    expect(estimateRows(overnight, p, { events_pin_strategy: 'split_main' })).toBe(2 + 1 + 1 + 3)
    expect(occurrences(every(et(5, 20), et(5, 21), 15)).map((t) => new Date(t).getUTCMinutes())).toEqual([0, 15, 30, 45])
  })
  it('submit needs at least one unpinned song', () => {
    expect(code(() => assertSubmittable({ tracks: [], announcements: [] }))).toBe('empty_playlist')
    expect(code(() => assertSubmittable({ tracks: [lib(0, 101, iso(et(5, 21)))], announcements: [] }))).toBe('empty_playlist')
    expect(code(() => assertSubmittable({ tracks: [lib(0, 101)], announcements: [] }))).toBe('ok')
  })
})

// ------------------------------------------------------------ edits -----

describe('re-approval and change detection', () => {
  it('title, time, visibility and play order need re-approval; details do not', () => {
    expect(needsReapproval(['startsAt'], false)).toBe(true)
    expect(needsReapproval(['visibility'], false)).toBe(true)
    expect(needsReapproval(['playlistOrder'], false)).toBe(true)
    expect(needsReapproval(['title'], false)).toBe(true)
    expect(needsReapproval(['description', 'hostName', 'location', 'eventType'], false)).toBe(false)
    expect(needsReapproval([], true)).toBe(true)
  })
  it('changedFields compares dates by instant', () => {
    const before = { title: 'a', hostName: null, description: null, location: null, eventType: 'other', startsAt: new Date(1000), endsAt: new Date(2000), visibility: 'public' as const, playlistOrder: 'shuffle' as const }
    expect(changedFields(before, { startsAt: new Date(1000), title: 'a' })).toEqual([])
    expect(changedFields(before, { endsAt: new Date(3000), title: 'b' })).toEqual(['endsAt', 'title'])
  })
  it('playlistKey ignores announcement order and labels, not song order', () => {
    const a = { tracks: [lib(0, 101), lib(1, 102)], announcements: [at(et(5, 21)), at(et(5, 22))], playlistOrder: 'shuffle' as const }
    const b = { ...a, announcements: [at(et(5, 22)), { ...at(et(5, 21)), label: { title: 'x', artist: null, lengthS: 1 } }] }
    expect(playlistKey(a)).toBe(playlistKey(b))
    expect(playlistKey(a)).not.toBe(playlistKey({ ...a, tracks: [lib(0, 102), lib(1, 101)] }))
    expect(playlistKey(a)).not.toBe(playlistKey({ ...a, playlistOrder: 'sequential' }))
  })
})

// ------------------------------------------------------------ state -----

describe('state machine', () => {
  const ev = (status: EventStatus, ownerUserId = OWNER.userId) => ({ ownerUserId, status })
  it('owner actions: submit draft, withdraw before live; not by others (even staff)', () => {
    expect(nextStatus('submit', ev('draft'), OWNER)).toBe('pending')
    expect(code(() => nextStatus('submit', ev('pending'), OWNER))).toBe('not_editable')
    expect(code(() => nextStatus('submit', ev('draft'), STAFF))).toBe('forbidden')
    for (const s of ['draft', 'pending', 'approved', 'built'] as EventStatus[]) expect(nextStatus('withdraw', ev(s), OWNER)).toBe('withdrawn')
    expect(code(() => nextStatus('withdraw', ev('live'), OWNER))).toBe('not_editable')
    expect(code(() => nextStatus('withdraw', ev('approved'), OTHER))).toBe('forbidden')
  })
  it('staff actions: approve/deny pending, cancel anything booked; members refused', () => {
    expect(nextStatus('approve', ev('pending'), STAFF)).toBe('approved')
    expect(nextStatus('deny', ev('pending'), STAFF)).toBe('denied')
    for (const s of TRANSITIONS.cancel.from) expect(nextStatus('cancel', ev(s), STAFF)).toBe('cancelled')
    expect(code(() => nextStatus('approve', ev('draft'), STAFF))).toBe('not_editable')
    expect(code(() => nextStatus('approve', ev('pending'), OWNER))).toBe('forbidden')
    expect(code(() => nextStatus('cancel', ev('ended'), STAFF))).toBe('not_editable')
  })
  it('jobs: submit opens the ticket; approve posts + builds only with autobuild', () => {
    const e = { id: 42, version: 3 }
    expect(jobsFor('submit', e, { autobuild: false, hasTicket: true, mayBeBuilt: false }).map((j) => j.kind)).toEqual(['ticket_open'])
    const off = jobsFor('approve', e, { autobuild: false, hasTicket: true, mayBeBuilt: false })
    expect(off.map((j) => j.kind)).toEqual(['ticket_post'])
    expect(off[0]!.payload).toMatchObject({ kind: 'approved', idem: 'approved:42:3' })
    expect(JSON.stringify(off[0]!.payload)).toContain('Staff will load it into the Events station')
    const on = jobsFor('approve', e, { autobuild: true, hasTicket: true, mayBeBuilt: false })
    expect(on.map((j) => j.kind)).toEqual(['ticket_post', 'build'])
    expect(on[1]!.payload).toEqual({ eventId: 42, version: 3 })
  })
  it('jobs: deny/withdraw/cancel post, close, and tear down when a build may exist', () => {
    const e = { id: 42, version: 3 }
    expect(jobsFor('deny', e, { autobuild: true, hasTicket: true, mayBeBuilt: false, reason: 'No' }).map((j) => j.kind)).toEqual(['ticket_post', 'ticket_close'])
    const c = jobsFor('cancel', e, { autobuild: true, hasTicket: true, mayBeBuilt: true, reason: 'Clash' })
    expect(c.map((j) => j.kind)).toEqual(['ticket_post', 'ticket_close', 'teardown'])
    expect(c[2]!.dedupeExtra).toBe('v3:cancel')
    expect(jobsFor('withdraw', e, { autobuild: true, hasTicket: false, mayBeBuilt: false })).toEqual([])
  })
})

// ------------------------------------------------------------ privacy ---

describe('viewEvent privacy (every surface uses this projection)', () => {
  const extras = (): FullExtras => ({
    tracks: [lib(0, 101), up(1, 501)],
    announcements: [at(et(5, 21))],
    lookup: lookup(),
    buildStatus: 'applied',
    appliedBuild: null,
    ownerName: 'Owner',
    settings: S,
    now: NOW,
  })
  const SECRETS = ['Secret Party Title', 'Secret Host', 'Secret description', 'Secret Location', 'My Mix', 'One', OWNER.discordId, 'tickets.example']
  const noSecrets = (v: unknown) => {
    const s = JSON.stringify(v)
    for (const x of SECRETS) expect(s).not.toContain(x)
  }

  it('a second member (and anonymous) never gets full, private or pending details', () => {
    for (const viewer of [OTHER, null]) {
      for (const status of ['pending', 'approved', 'built', 'live', 'ended'] as EventStatus[]) {
        const priv = viewEvent(record({ status, visibility: 'private' }), viewer, extras)!
        expect(priv.kind).toBe(status === 'pending' ? 'pending' : 'private')
        noSecrets(priv)
        expect(Object.keys(priv).sort()).toEqual(['endsAt', 'id', 'kind', 'label', 'startsAt', 'status'])
        const pub = viewEvent(record({ status, visibility: 'public' }), viewer, extras)!
        if (status === 'pending') {
          expect(pub.kind).toBe('pending')
          noSecrets(pub)
        } else {
          expect(pub.kind).toBe('public')
          expect(Object.keys(pub).sort()).toEqual(['description', 'endsAt', 'eventType', 'hostName', 'id', 'kind', 'location', 'startsAt', 'status', 'title'])
        }
        expect(EventViewSchema.parse(pub)).toBeTruthy()
        expect(EventViewSchema.parse(priv)).toBeTruthy()
      }
      for (const status of ['draft', 'denied', 'withdrawn', 'cancelled', 'expired', 'failed'] as EventStatus[]) {
        expect(viewEvent(record({ status }), viewer, extras)).toBeNull()
      }
    }
  })
  it('a rolled-back event (status failed) is hidden publicly; staff still see it, labelled', () => {
    for (const visibility of ['public', 'private'] as const) {
      for (const viewer of [OTHER, null]) expect(viewEvent(record({ status: 'failed', visibility }), viewer, extras)).toBeNull()
      const full = viewEvent(record({ status: 'failed', visibility }), STAFF, extras)!
      expect(full.kind).toBe('full')
      expect(full.status).toBe('failed')
    }
    expect(EVENT_STATUS.failed.label).toBe('Failed — rolled back')
  })
  it('the full projection is never computed for a stranger', () => {
    let called = 0
    viewEvent(record(), OTHER, () => (called++, extras()))
    viewEvent(record(), null, () => (called++, extras()))
    expect(called).toBe(0)
  })
  it('owner and staff get full, with labels, version and ticket details, schema-valid', () => {
    for (const viewer of [OWNER, STAFF]) {
      const v = viewEvent(record({ status: 'draft', visibility: 'private' }), viewer, extras)!
      expect(v.kind).toBe('full')
      const f = FullEventViewSchema.parse(v)
      expect(f.version).toBe(3)
      expect(f.ticketNumber).toBe(7)
      expect(f.ownerName).toBe('Owner')
      expect(f.tracks[0]!.label).toEqual({ title: 'One', artist: 'A', lengthS: 200 })
      expect(f.tracks[1]!.label).toEqual({ title: 'My Mix', artist: 'Me', lengthS: 600 })
      expect(f.announcements[0]!.label).toEqual({ title: 'EFM ID', artist: null, lengthS: 12 })
      expect(f.freezeAt).toBe(iso(et(5, 19, 30)))
      expect(EventMutationResponse.parse({ event: v })).toBeTruthy()
    }
    expect((viewEvent(record(), OWNER, extras) as { canEdit: boolean }).canEdit).toBe(true)
  })
  it('a full view echoed back as a playlist PUT still parses (labels are ignored input)', () => {
    const f = fullView(record(), OWNER, extras())
    expect(PutPlaylistRequest.safeParse({ tracks: f.tracks, announcements: f.announcements, playlistOrder: f.playlistOrder }).success).toBe(true)
  })
})

// ------------------------------------------------------------ ICS -------

describe('ICS feed', () => {
  const K = Buffer.alloc(32, 7)
  const views = [record({ id: 1 }), record({ id: 2, visibility: 'private' }), record({ id: 3, status: 'pending' }), record({ id: 4, status: 'draft' })]
    .map(publicView)
    .filter((v): v is NonNullable<typeof v> => v !== null)
  const ics = buildIcs(views, { now: new Date(NOW), origin: 'https://events.euphoric.fm', k: K })
  const unfolded = ics.replace(/\r\n /g, '')
  const vevents = unfolded.split('BEGIN:VEVENT').slice(1)

  it('only calendar statuses, CRLF lines ≤ 75 octets', () => {
    expect(vevents).toHaveLength(3)
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
  })
  it('public entries carry details; private/pending only the label and time', () => {
    expect(vevents[0]).toContain('SUMMARY:Secret Party Title')
    expect(vevents[0]).toContain('LOCATION:Secret Location')
    expect(vevents[1]).toContain('SUMMARY:Booked · Private event')
    expect(vevents[2]).toContain('SUMMARY:Pending')
    for (const v of [vevents[1]!, vevents[2]!]) {
      expect(v).not.toMatch(/DESCRIPTION|LOCATION|URL|Secret/)
      expect(v).toContain('DTSTART:20261006T000000Z')
    }
  })
  it('UIDs are opaque (HMAC of the id), stable, and do not contain the id', () => {
    expect(icsUid(2, K)).toBe(icsUid(2, K))
    expect(icsUid(2, K)).not.toBe(icsUid(3, K))
    expect(icsUid(2, K)).toMatch(/^[0-9a-f]{32}@events\.euphoric\.fm$/)
    expect(vevents[1]).toContain(`UID:${icsUid(2, K)}`)
  })
  it('escapes TEXT and folds long lines', () => {
    expect(icsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne')
    const f = foldLine('X'.repeat(200))
    expect(f.split('\r\n ').every((l) => l.length <= 75)).toBe(true)
    expect(f.replace(/\r\n /g, '')).toBe('X'.repeat(200))
  })
})

// ------------------------------------------------------------ tickets ---

describe('ticket copy', () => {
  const side = (over: Partial<DiffSide> = {}): DiffSide => ({
    title: 'T',
    hostName: null,
    description: null,
    location: null,
    eventType: 'club_night',
    startsAt: new Date(et(5, 20)),
    endsAt: new Date(et(5, 23)),
    visibility: 'public',
    playlistOrder: 'shuffle',
    songs: ['A – One', 'B – Two'],
    pins: [],
    announcements: [],
    ...over,
  })
  it('diffs time, visibility, songs; nothing for no change', () => {
    expect(diffLines(side(), side())).toEqual([])
    const d = diffLines(side(), side({ startsAt: new Date(et(5, 21)), visibility: 'private', songs: ['A – One', 'C – Three'] }))
    expect(d[0]).toMatch(/^Time: Mon, Oct 5, 2026, 8:00\sPM – 11:00\sPM ET → Mon, Oct 5, 2026, 9:00\sPM – 11:00\sPM ET$/)
    expect(d).toContain('Visibility: Public → Private')
    expect(d).toContain('Songs: 2 → 2')
    expect(d).toContain('  + C – Three')
    expect(d).toContain('  − B – Two')
  })
  it('edited body says re-approval is needed and stays under the worker cap', () => {
    const body = editedBody(Array.from({ length: 500 }, (_, i) => `  + song ${i}`), { byStaff: false, reapproval: true })
    expect(body.length).toBeLessThanOrEqual(1800)
    expect(editedBody(['Title: x'], { byStaff: false, reapproval: true })).toContain('need staff approval again')
  })
})

describe('probe request id', () => {
  it('is a deterministic v4-shaped UUID of the tus id', () => {
    const id = probeRequestIdForUpload('0123456789abcdef0123456789abcdef')
    expect(id).toBe('01234567-89ab-4def-8123-456789abcdef')
    expect(() => probeRequestIdForUpload('../x')).toThrow()
  })
})

describe('reserved titles (0.5.2: a title never passes for a helper playlist)', () => {
  // Any DB access fails the test: the refusal comes before the database.
  const noDb = new Proxy({}, { get: () => { throw new Error('db touched') } }) as never
  const input = { title: 'x', hostName: null, description: null, location: null, eventType: 'party', startsAt: new Date(NOW + 48 * H).toISOString(), endsAt: new Date(NOW + 50 * H).toISOString(), enteredTz: 'America/New_York', visibility: 'public', playlistOrder: 'shuffle' } as never as Parameters<typeof svc.createEvent>[2]
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message ?? 'error')

  it('create, staff booking and title edits answer title_reserved for EVT<id> s<n> / a<n> in any case or spelling', async () => {
    for (const title of ['EVT1 s1', 'EVT42 a3', 'evt1 S1', '~EVT1 s1', 'EVT1-s1', 'E.V.T.1 s1', 'ＥＶＴ１ ｓ１']) {
      expect(await code(svc.createEvent(noDb, member(), { ...input, title })), title).toBe('title_reserved')
      expect(await code(svc.staffBook(noDb, { ...member(), staff: true }, { ...input, title, openTicket: false } as never)), title).toBe('title_reserved')
      expect(await code(svc.patchEvent(noDb, member(), 1, { title })), title).toBe('title_reserved')
    }
    // an ordinary title gets past the check (and then needs the database)
    expect(await code(svc.createEvent(noDb, member(), { ...input, title: 'EVT1 s1 afterparty' }))).toBe('db touched')
  })
})
