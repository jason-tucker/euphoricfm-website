import { describe, expect, it } from 'vitest'
import { assertRowsInsideEvent, PlaylistBody } from '@/events/azuracast/allowlist'
import { compile, CompileError, SPLIT_MAIN_GAP_MS, type CompileInput } from '@/events/azuracast/compiler'
import { etDate, etHhmm, etWallToUtc, isFallBackDate, isSpringForwardDate, splitByEtDate } from '@/events/azuracast/time'

const T = (iso: string) => new Date(iso)
const NOW = T('2026-09-29T12:00:00Z')

function input(over: Partial<CompileInput> & { startsAt?: string; endsAt?: string } = {}): CompileInput {
  const { startsAt, endsAt, ...rest } = over
  return {
    event: {
      id: 42,
      version: 3,
      startsAt: T(startsAt ?? '2026-10-10T20:00:00-04:00'),
      endsAt: T(endsAt ?? '2026-10-10T22:00:00-04:00'),
      mainName: 'Grand Opening',
      playlistOrder: 'shuffle',
      ...(rest.event ?? {}),
    },
    tracks: rest.tracks ?? [
      { position: 1, mediaId: 501, pinAt: null },
      { position: 2, mediaId: 502, pinAt: null },
    ],
    announcements: rest.announcements ?? [],
    settings: { maxRows: 150, pinStrategy: 'overlap', announceStrategy: 'interrupt_rows', ...(rest.settings ?? {}) },
    now: rest.now ?? NOW,
  }
}

function fails(i: CompileInput, code: string) {
  try {
    compile(i)
  } catch (e) {
    expect(e).toBeInstanceOf(CompileError)
    expect((e as CompileError).code).toBe(code)
    return
  }
  throw new Error(`expected CompileError ${code}`)
}

const rowsOf = (i: CompileInput, key: string) => compile(i).playlists.find((p) => p.key === key)!.body.schedule_items

describe('ET time helpers', () => {
  it('knows the 2026 fall-back and 2027 spring-forward days', () => {
    expect(isFallBackDate('2026-11-01')).toBe(true)
    expect(isFallBackDate('2026-10-31')).toBe(false)
    expect(isSpringForwardDate('2027-03-14')).toBe(true)
    expect(isSpringForwardDate('2027-03-13')).toBe(false)
  })

  it('maps wall times to 0, 1 or 2 instants', () => {
    expect(etWallToUtc('2026-11-01', 90).map((t) => new Date(t).toISOString())).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'])
    expect(etWallToUtc('2027-03-14', 150)).toEqual([])
    expect(etWallToUtc('2027-03-14', 180).map((t) => new Date(t).toISOString())).toEqual(['2027-03-14T07:00:00.000Z'])
    expect(etWallToUtc('2026-10-10', 1200).map((t) => new Date(t).toISOString())).toEqual(['2026-10-11T00:00:00.000Z'])
  })

  it('splits by ET date, per occurrence', () => {
    const segs = splitByEtDate(T('2026-10-31T22:00:00-04:00').getTime(), T('2026-11-01T04:00:00-05:00').getTime())
    expect(segs.map((s) => s.date)).toEqual(['2026-10-31', '2026-11-01'])
    expect(etHhmm(T('2027-03-14T08:00:00Z').getTime())).toBe(400)
    expect(etDate(T('2026-11-01T03:59:00Z').getTime())).toBe('2026-10-31')
  })
})

describe('compiler: main playlist', () => {
  it('one dated row, pinned body fields, public name', () => {
    const plan = compile(input())
    expect(plan.playlists).toHaveLength(1)
    const main = plan.playlists[0]!
    expect(main.key).toBe('main')
    expect(main.name).toBe('Grand Opening')
    expect(main.mediaIds).toEqual([501, 502])
    expect(main.body).toMatchObject({ type: 'default', source: 'songs', order: 'shuffle', is_enabled: true, is_jingle: false, include_in_requests: false, include_in_on_demand: false, backend_options: [], weight: 3 })
    expect(main.body.schedule_items).toEqual([{ start_time: 2000, end_time: 2200, start_date: '2026-10-10', end_date: '2026-10-10', days: [], loop_once: false }])
    expect(plan.rowCount).toBe(1)
    expect(plan.warnings).toEqual([])
    expect(PlaylistBody.safeParse(main.body).success).toBe(true)
  })

  it('sequential keeps position order and turns duplicate avoidance off', () => {
    const i = input({ event: { ...input().event, playlistOrder: 'sequential' }, tracks: [{ position: 2, mediaId: 7, pinAt: null }, { position: 1, mediaId: 9, pinAt: null }] })
    const main = compile(i).playlists[0]!
    expect(main.body.order).toBe('sequential')
    expect(main.sequential).toBe(true)
    expect(main.body.avoid_duplicates).toBe(false)
    expect(main.mediaIds).toEqual([9, 7])
  })

  it('a private event uses the contract name', () => {
    const main = compile(input({ event: { ...input().event, mainName: 'Private event' } })).playlists[0]!
    expect(main.name).toBe('Private event')
  })

  it('refuses a name the wrapper would refuse', () => {
    fails(input({ event: { ...input().event, mainName: '~sneaky' } }), 'invalid_main_name')
    fails(input({ event: { ...input().event, mainName: 'a/b' } }), 'invalid_main_name')
    fails(input({ event: { ...input().event, mainName: 'x'.repeat(61) } }), 'invalid_main_name')
  })

  it('midnight-crossing event: split per date, [start,2359] + [0000,end], warned', () => {
    const plan = compile(input({ startsAt: '2026-10-10T22:00:00-04:00', endsAt: '2026-10-11T01:00:00-04:00' }))
    expect(plan.playlists[0]!.body.schedule_items.map((r) => [r.start_date, r.start_time, r.end_time])).toEqual([
      ['2026-10-10', 2200, 2359],
      ['2026-10-11', 0, 100],
    ])
    expect(plan.warnings).toContain('crosses_midnight')
  })

  it('multi-day staff event: one row per ET date', () => {
    const rows = rowsOf(input({ startsAt: '2026-10-10T12:00:00-04:00', endsAt: '2026-10-12T12:00:00-04:00' }), 'main')
    expect(rows.map((r) => [r.start_date, r.start_time, r.end_time])).toEqual([
      ['2026-10-10', 1200, 2359],
      ['2026-10-11', 0, 2359],
      ['2026-10-12', 0, 1200],
    ])
  })

  it('DST fall-back 2026-11-01 across the night: wall-clock rows, dated per occurrence', () => {
    const i = input({ startsAt: '2026-10-31T22:00:00-04:00', endsAt: '2026-11-01T04:00:00-05:00' })
    const plan = compile(i)
    expect(plan.playlists[0]!.body.schedule_items.map((r) => [r.start_date, r.start_time, r.end_time])).toEqual([
      ['2026-10-31', 2200, 2359],
      ['2026-11-01', 0, 400],
    ])
    expect(plan.warnings).toEqual(['crosses_midnight', 'overlaps_nightly_restart'])
    assertRowsInsideEvent(plan.playlists[0]!.body.schedule_items, { startsAt: i.event.startsAt.getTime(), endsAt: i.event.endsAt.getTime() })
  })

  it('DST fall-back: an event boundary inside the repeated hour is refused', () => {
    fails(input({ startsAt: '2026-11-01T00:00:00-04:00', endsAt: '2026-11-01T01:30:00-05:00' }), 'dst_ambiguous')
    fails(input({ startsAt: '2026-11-01T01:30:00-04:00', endsAt: '2026-11-01T03:00:00-05:00' }), 'dst_ambiguous')
  })

  it('DST spring-forward 2027-03-14: rows stay on the wall clock', () => {
    const i = input({ startsAt: '2027-03-14T00:00:00-05:00', endsAt: '2027-03-14T05:00:00-04:00', now: T('2027-03-01T00:00:00Z') })
    const rows = rowsOf(i, 'main')
    expect(rows).toEqual([{ start_time: 0, end_time: 500, start_date: '2027-03-14', end_date: '2027-03-14', days: [], loop_once: false }])
    assertRowsInsideEvent(rows, { startsAt: i.event.startsAt.getTime(), endsAt: i.event.endsAt.getTime() })
  })

  it('refuses duplicate songs, an all-pinned list and an ended event', () => {
    fails(input({ tracks: [{ position: 1, mediaId: 5, pinAt: null }, { position: 2, mediaId: 5, pinAt: null }] }), 'duplicate_song')
    fails(input({ tracks: [{ position: 1, mediaId: 5, pinAt: T('2026-10-10T20:30:00-04:00') }] }), 'no_main_songs')
    fails(input({ now: T('2026-10-11T03:00:00Z') }), 'event_ended')
  })
})

describe('compiler: pins', () => {
  const pinned = (at: string, over: Partial<CompileInput> = {}) =>
    input({ tracks: [{ position: 1, mediaId: 501, pinAt: null }, { position: 2, mediaId: 777, pinAt: T(at) }], ...over })

  it('single_track + loop_once, window [pin, pin+15], no interrupt, not in main', () => {
    const plan = compile(pinned('2026-10-10T20:30:00-04:00'))
    const pin = plan.playlists.find((p) => p.key === 's1')!
    expect(pin.name).toBe('EVT42 s1')
    expect(pin.role).toBe('pin')
    expect(pin.mediaIds).toEqual([777])
    expect(pin.body.backend_options).toEqual(['single_track'])
    expect(pin.body.schedule_items).toEqual([{ start_time: 2030, end_time: 2045, start_date: '2026-10-10', end_date: '2026-10-10', days: [], loop_once: true }])
    expect(plan.playlists[0]!.mediaIds).toEqual([501])
  })

  it('a pin at end − 15 is fine; later is refused; outside the event is refused', () => {
    expect(rowsOf(pinned('2026-10-10T21:45:00-04:00'), 's1')[0]).toMatchObject({ start_time: 2145, end_time: 2200 })
    fails(pinned('2026-10-10T21:50:00-04:00'), 'pin_too_late')
    fails(pinned('2026-10-10T19:55:00-04:00'), 'pin_outside_event')
  })

  it('a pin window crossing midnight is truncated at 23:59 (one row, never split)', () => {
    const i = pinned('2026-10-10T23:50:00-04:00', { event: { ...input().event, startsAt: T('2026-10-10T22:00:00-04:00'), endsAt: T('2026-10-11T01:00:00-04:00') } })
    expect(rowsOf(i, 's1')).toEqual([{ start_time: 2350, end_time: 2359, start_date: '2026-10-10', end_date: '2026-10-10', days: [], loop_once: true }])
    const late = pinned('2026-10-10T23:59:00-04:00', { event: { ...input().event, startsAt: T('2026-10-10T22:00:00-04:00'), endsAt: T('2026-10-11T01:00:00-04:00') } })
    fails(late, 'row_too_short')
  })

  it('refuses pins touching 01:55–02:05 ET and the repeated fall-back hour', () => {
    const night = { ...input().event, startsAt: T('2026-10-10T23:00:00-04:00'), endsAt: T('2026-10-11T04:00:00-04:00') }
    fails(pinned('2026-10-11T01:45:00-04:00', { event: night }), 'pin_in_restart_window')
    fails(pinned('2026-10-11T02:00:00-04:00', { event: night }), 'pin_in_restart_window')
    expect(rowsOf(pinned('2026-10-11T02:05:00-04:00', { event: night }), 's1')[0]).toMatchObject({ start_time: 205, end_time: 220 })
    const fallNight = { ...input().event, startsAt: T('2026-10-31T23:00:00-04:00'), endsAt: T('2026-11-01T04:00:00-05:00') }
    fails(pinned('2026-11-01T00:50:00-04:00', { event: fallNight }), 'dst_ambiguous')
    expect(rowsOf(pinned('2026-11-01T00:30:00-04:00', { event: fallNight }), 's1')[0]).toMatchObject({ start_date: '2026-11-01', start_time: 30, end_time: 45 })
  })

  it('spring-forward: a pin after the gap is converted with the new offset', () => {
    const ev = { ...input().event, startsAt: T('2027-03-14T00:00:00-05:00'), endsAt: T('2027-03-14T05:00:00-04:00') }
    const rows = rowsOf(pinned('2027-03-14T07:00:00Z', { event: ev, now: T('2027-03-01T00:00:00Z') }), 's1')
    expect(rows[0]).toMatchObject({ start_date: '2027-03-14', start_time: 300, end_time: 315 })
    fails(pinned('2027-03-14T06:50:00Z', { event: ev, now: T('2027-03-01T00:00:00Z') }), 'pin_in_restart_window')
  })

  it('pins are numbered by time', () => {
    const plan = compile(
      input({
        tracks: [
          { position: 1, mediaId: 1, pinAt: null },
          { position: 2, mediaId: 2, pinAt: T('2026-10-10T21:00:00-04:00') },
          { position: 3, mediaId: 3, pinAt: T('2026-10-10T20:15:00-04:00') },
        ],
      }),
    )
    expect(plan.playlists.filter((p) => p.role === 'pin').map((p) => [p.name, p.mediaIds[0]])).toEqual([
      ['EVT42 s1', 3],
      ['EVT42 s2', 2],
    ])
  })
})

describe('compiler: announcements', () => {
  const ann = (a: Partial<CompileInput['announcements'][number]>) => ({ mediaId: 900, durationS: 45, mode: 'at' as const, at: null, everyMin: null, from: null, until: null, ...a })

  it("'at': interrupt + single_track + loop_once, [t, t+dur+1m] rounded up", () => {
    const plan = compile(input({ announcements: [ann({ at: T('2026-10-10T20:30:00-04:00') })] }))
    const a = plan.playlists.find((p) => p.key === 'a1')!
    expect(a.name).toBe('EVT42 a1')
    expect(a.body.backend_options).toEqual(['interrupt', 'single_track'])
    expect(a.body.schedule_items).toEqual([{ start_time: 2030, end_time: 2032, start_date: '2026-10-10', end_date: '2026-10-10', days: [], loop_once: true }])
  })

  it("'every' expands per occurrence (t < until) into one playlist per distinct audio", () => {
    const plan = compile(
      input({
        announcements: [
          ann({ mode: 'every', everyMin: 15, from: T('2026-10-10T20:00:00-04:00'), until: T('2026-10-10T21:00:00-04:00') }),
          ann({ mediaId: 901, at: T('2026-10-10T21:10:00-04:00') }),
        ],
      }),
    )
    const a1 = plan.playlists.find((p) => p.key === 'a1')!
    expect(a1.mediaIds).toEqual([900])
    expect(a1.body.schedule_items.map((r) => r.start_time)).toEqual([2000, 2015, 2030, 2045])
    expect(plan.playlists.find((p) => p.key === 'a2')!.mediaIds).toEqual([901])
    expect(plan.rowCount).toBe(1 + 4 + 1)
  })

  it('the same audio in two announcements shares one playlist', () => {
    const plan = compile(input({ announcements: [ann({ at: T('2026-10-10T20:30:00-04:00') }), ann({ at: T('2026-10-10T21:30:00-04:00') })] }))
    expect(plan.playlists.filter((p) => p.role === 'announce')).toHaveLength(1)
    expect(plan.playlists.find((p) => p.key === 'a1')!.body.schedule_items).toHaveLength(2)
  })

  it('clamps only the +1 min slack to the event end; refuses audio past the end', () => {
    expect(rowsOf(input({ announcements: [ann({ durationS: 30, at: T('2026-10-10T21:59:00-04:00') })] }), 'a1')[0]).toMatchObject({ start_time: 2159, end_time: 2200 })
    fails(input({ announcements: [ann({ durationS: 90, at: T('2026-10-10T21:59:00-04:00') })] }), 'announcement_past_end')
    fails(input({ announcements: [ann({ at: T('2026-10-10T22:00:00-04:00') })] }), 'announcement_outside_event')
  })

  it('refuses overlapping announcements, midnight crossings, the restart band and the repeated hour', () => {
    fails(input({ announcements: [ann({ durationS: 300, at: T('2026-10-10T20:30:00-04:00') }), ann({ mediaId: 901, at: T('2026-10-10T20:35:00-04:00') })] }), 'announcement_overlap')
    fails(input({ announcements: [ann({ mode: 'every', everyMin: 15, durationS: 20 * 60, from: T('2026-10-10T20:00:00-04:00'), until: T('2026-10-10T21:00:00-04:00') })] }), 'announcement_overlap')
    const night = { ...input().event, startsAt: T('2026-10-10T23:00:00-04:00'), endsAt: T('2026-10-11T04:00:00-04:00') }
    fails(input({ event: night, announcements: [ann({ at: T('2026-10-10T23:59:00-04:00') })] }), 'announcement_crosses_midnight')
    fails(input({ event: night, announcements: [ann({ at: T('2026-10-11T01:55:00-04:00') })] }), 'announcement_in_restart_window')
    fails(input({ event: night, announcements: [ann({ durationS: 300, at: T('2026-10-11T01:50:00-04:00') })] }), 'announcement_in_restart_window')
    expect(rowsOf(input({ event: night, announcements: [ann({ durationS: 30, at: T('2026-10-11T01:50:00-04:00') })] }), 'a1')[0]).toMatchObject({ start_time: 150, end_time: 152 })
    const fallNight = { ...input().event, startsAt: T('2026-10-31T23:00:00-04:00'), endsAt: T('2026-11-01T04:00:00-05:00') }
    fails(input({ event: fallNight, announcements: [ann({ at: T('2026-11-01T01:10:00-05:00') })] }), 'dst_ambiguous')
  })

  it('spring-forward: an occurrence after the gap gets EDT', () => {
    const ev = { ...input().event, startsAt: T('2027-03-14T00:00:00-05:00'), endsAt: T('2027-03-14T05:00:00-04:00') }
    const rows = rowsOf(input({ event: ev, now: T('2027-03-01T00:00:00Z'), announcements: [ann({ mode: 'every', everyMin: 60, from: T('2027-03-14T00:00:00-05:00'), until: T('2027-03-14T05:00:00-04:00') })] }), 'a1')
    // 00:00 EST, 01:00 EST, 03:00 EDT (02:00 EST does not exist), 04:00 EDT
    expect(rows.map((r) => r.start_time)).toEqual([0, 100, 300, 400])
  })
})

describe('compiler: caps and strategies', () => {
  it('row cap: every 15 min for 24 h is 96 rows (+ main per date); over the cap is refused', () => {
    const i = input({
      startsAt: '2026-10-12T00:00:00-04:00',
      endsAt: '2026-10-12T23:59:00-04:00',
      announcements: [{ mediaId: 900, durationS: 20, mode: 'every', everyMin: 15, at: null, from: null, until: null }],
    })
    // 01:55–02:05: the 02:00 occurrence is refused, so start at 02:15 instead
    i.announcements = [
      { mediaId: 900, durationS: 20, mode: 'every', everyMin: 15, at: null, from: T('2026-10-12T02:15:00-04:00'), until: T('2026-10-12T23:59:00-04:00') },
    ]
    const plan = compile(i)
    expect(plan.rowCount).toBe(1 + 87)
    fails({ ...i, settings: { ...i.settings, maxRows: 50 } }, 'row_cap')
  })

  it('overlap_weight: pin 25, main 1; interrupt_weight: announcements 25', () => {
    const plan = compile(
      input({
        tracks: [{ position: 1, mediaId: 1, pinAt: null }, { position: 2, mediaId: 2, pinAt: T('2026-10-10T20:30:00-04:00') }],
        announcements: [{ mediaId: 900, durationS: 30, mode: 'at', at: T('2026-10-10T21:00:00-04:00'), everyMin: null, from: null, until: null }],
        settings: { maxRows: 150, pinStrategy: 'overlap_weight', announceStrategy: 'interrupt_weight' },
      }),
    )
    expect(plan.playlists.find((p) => p.key === 'main')!.body.weight).toBe(1)
    expect(plan.playlists.find((p) => p.key === 's1')!.body.weight).toBe(25)
    expect(plan.playlists.find((p) => p.key === 'a1')!.body.weight).toBe(25)
  })

  it('split_main: the main rows leave a gap after each pin', () => {
    expect(SPLIT_MAIN_GAP_MS).toBe(5 * 60_000)
    const plan = compile(
      input({
        tracks: [{ position: 1, mediaId: 1, pinAt: null }, { position: 2, mediaId: 2, pinAt: T('2026-10-10T20:30:00-04:00') }],
        settings: { maxRows: 150, pinStrategy: 'split_main', announceStrategy: 'interrupt_rows' },
      }),
    )
    expect(plan.playlists[0]!.body.schedule_items.map((r) => [r.start_time, r.end_time])).toEqual([
      [2000, 2030],
      [2035, 2200],
    ])
    expect(plan.playlists.find((p) => p.key === 's1')!.body.schedule_items[0]).toMatchObject({ start_time: 2030, end_time: 2045 })
  })

  it('every body the compiler emits passes the wrapper schema and the inside-event check', () => {
    const i = input({
      startsAt: '2026-10-10T20:00:00-04:00',
      endsAt: '2026-10-11T01:00:00-04:00',
      tracks: [{ position: 1, mediaId: 1, pinAt: null }, { position: 2, mediaId: 2, pinAt: T('2026-10-10T23:50:00-04:00') }],
      announcements: [{ mediaId: 900, durationS: 30, mode: 'every', everyMin: 30, at: null, from: null, until: T('2026-10-10T23:30:00-04:00') }],
    })
    const plan = compile(i)
    for (const p of plan.playlists) {
      expect(PlaylistBody.safeParse(p.body).success).toBe(true)
      assertRowsInsideEvent(p.body.schedule_items, { startsAt: i.event.startsAt.getTime(), endsAt: i.event.endsAt.getTime() })
      for (const r of p.body.schedule_items) {
        expect(r.start_date).toBe(r.end_date)
        expect(r.start_time).toBeLessThan(r.end_time)
      }
    }
  })

  it('is deterministic', () => {
    expect(JSON.stringify(compile(input()))).toBe(JSON.stringify(compile(input())))
  })
})
