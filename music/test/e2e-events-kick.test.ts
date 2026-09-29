// v0.5.2 events start kick, end to end through the real containers: the
// 2026-09-29 station-14 outage (live test 2) replayed against the AzuraCast
// mock. The mock regenerates "the .liq" on every restart like AzuraCast: an
// ENABLED playlist whose name makes an invalid Liquidsoap variable ("~EVT1 s1"
// → playlist_~evt1_s1) leaves the backend down ("Error 2: Parse error"). The
// events worker must see backend_running=false after its restart, disable
// every playlist of the event, restart once more, confirm the station is back,
// fail the build and alert — never retry into the same config.
//
// The event is staff-booked to start ~2.5 min from now (staff are exempt from
// the notice rules), built with the 0.5.2 names, then the pin playlist is put
// back into production's pre-0.5.2 state (the old '~' name on the registry row
// and the station) before the kick.
//
// Tag (helpers/events.ts): [A+C] events API + events worker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '@/server/db/client'
import { etParts } from '@/events/azuracast/time'
import { ownerSql } from './helpers/db'
import { ADMIN_ID, clearEventsSettings, control, evJson, evLoginOk, EVENTS_E2E, seedLibrarySongs, setEventsSettings, station14, uniqTag, waitEventStatus, type Jar, type MockMedia } from './helpers/events'
import { isLiquidsoapSafePlaylistName } from './helpers/azuracast-liq'
import { waitFor } from './helpers/wait'

const SETTINGS = ['events_enabled', 'events_autobuild_enabled', 'events_uploads_enabled']

// Pins and kicks near AzuraCast's nightly restart (01:55–02:05 ET) are
// refused by design; this suite books "now", so it stands aside then.
function nearNightlyRestart(ms: number): boolean {
  const p = etParts(ms)
  const m = p.hh * 60 + p.mm
  return m >= 90 && m <= 150
}

describe.skipIf(!EVENTS_E2E())('events start kick: restart confirmation + rollback (2026-09-29 outage)', () => {
  const tag = uniqTag()
  let admin: Jar
  let songs: MockMedia[]

  const registry = async (eventId: number) =>
    (await ownerSql()`SELECT role, intent_name, playlist_id FROM event_registry WHERE event_id = ${eventId} AND deleted_at IS NULL ORDER BY id`) as unknown as { role: string; intent_name: string; playlist_id: number | null }[]
  const audits = async (action: string, targetType: string, targetId: string) =>
    (await ownerSql()`SELECT action, detail FROM audit_log WHERE action = ${action} AND target_type = ${targetType} AND target_id = ${targetId} ORDER BY id`) as unknown as { action: string; detail: Record<string, unknown> }[]

  beforeAll(async () => {
    await setEventsSettings({ events_enabled: true, events_autobuild_enabled: false, events_uploads_enabled: false })
    admin = await evLoginOk({ id: ADMIN_ID })
    songs = await seedLibrarySongs([
      { path: `Music/Artists/EvKick ${tag}/EvKick ${tag} - One.mp3`, title: 'One', artist: `EvKick ${tag}` },
      { path: `Music/Artists/EvKick ${tag}/EvKick ${tag} - Two.mp3`, title: 'Two', artist: `EvKick ${tag}` },
    ])
    await control('/__mock/az/station14/backend', { running: true, forceDown: 0, restartErrorsWhenDown: false })
  })
  afterAll(async () => {
    await control('/__mock/az/station14/backend', { running: true, forceDown: 0, restartErrorsWhenDown: false })
    await clearEventsSettings(SETTINGS)
    await closeDb()
  })

  it('[A+C] a start kick into a config Liquidsoap refuses is rolled back: event playlists disabled, one more restart, station back, build failed, alert', { timeout: 360_000 }, async () => {
    const now = Date.now()
    if (nearNightlyRestart(now) || nearNightlyRestart(now + 15 * 60_000)) return
    // starts on a whole minute ≥ 150 s from now; a pinned song 10 min in (5-min grid)
    const startsAt = Math.ceil((now + 150_000) / 60_000) * 60_000
    const endsAt = startsAt + 60 * 60_000
    const pinAt = Math.ceil((startsAt + 10 * 60_000) / 300_000) * 300_000
    const book = await evJson<{ event: { id: number; status: string } }>(admin, '/api/ev/staff/book', {
      json: {
        title: `Kick ${tag}`,
        hostName: 'E2E Host',
        description: 'start kick rollback',
        location: 'Vinewood Bowl',
        eventType: 'club_night',
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        enteredTz: 'America/New_York',
        visibility: 'public',
        playlistOrder: 'shuffle',
        openTicket: false,
      },
    })
    expect(book.status).toBe(201)
    const id = book.body.event.id
    expect(book.body.event.status).toBe('approved')
    const put = await evJson(admin, `/api/ev/events/${id}/playlist`, {
      method: 'PUT',
      json: {
        tracks: [
          { position: 1, source: 'library', mediaId: songs[0]!.id, audioId: null, pinAt: null },
          { position: 2, source: 'library', mediaId: songs[1]!.id, audioId: null, pinAt: new Date(pinAt).toISOString() },
        ],
        announcements: [],
        playlistOrder: 'shuffle',
      },
    })
    expect(put.status).toBe(200)
    expect((await evJson(admin, `/api/ev/events/${id}/build-now`, { json: {} })).status).toBe(200)
    await waitEventStatus(id, 'built', 90_000)

    // 0.5.2 names: ASCII, no '~', Liquidsoap-safe
    const reg = await registry(id)
    const pin = reg.find((r) => r.role === 'pin')!
    expect(pin.intent_name).toBe(`EVT${id} s1`)
    let st = await station14()
    for (const r of reg) {
      const pl = st.playlists.find((p) => p.id === r.playlist_id)!
      expect(pl.name).toBe(r.intent_name)
      expect(isLiquidsoapSafePlaylistName(pl.name)).toBe(true)
    }
    expect(Date.now()).toBeLessThan(startsAt - 10_000) // the kick has not run yet

    // production's pre-0.5.2 state: the pin playlist carries the old '~' name
    const legacy = `~EVT${id} s1`
    await ownerSql()`UPDATE event_registry SET intent_name = ${legacy} WHERE playlist_id = ${pin.playlist_id}`
    const pinPl = st.playlists.find((p) => p.id === pin.playlist_id)!
    await control('/__mock/az/station14/playlist', { ...pinPl, name: legacy })
    const restartsBefore = st.restarts.length

    // the kick at start + 5 s: restart → backend down → ~40 s of status reads → rollback
    const rolled = await waitFor(async () => {
      const a = await audits('events.kick.rolled_back', 'event', String(id))
      return a.length > 0 ? a[0]! : null
    }, startsAt + 5_000 - Date.now() + 150_000, 2000)
    expect(rolled.detail).toMatchObject({ restored: true })

    st = await station14()
    expect(st.restarts.length - restartsBefore).toBe(2) // the kick + the rollback, never more
    expect(st.backendRunning).toBe(true)
    expect(st.log).toContain(`Error 2: Parse error (playlist_~evt${id}_s1`)
    for (const r of await registry(id)) expect(st.playlists.find((p) => p.id === r.playlist_id)!.is_enabled).toBe(false)
    expect(st.violations).toEqual([])

    const failed = (await audits('events.kick.start_failed', 'event', String(id)))[0]!
    expect(failed.detail).toMatchObject({ stage: 'not_running', backend: 'not running' })
    const [ev] = (await ownerSql()`SELECT status FROM events WHERE id = ${id}`) as unknown as { status: string }[]
    expect(ev!.status).toBe('built')
    const [build] = (await ownerSql()`SELECT status, last_error FROM event_builds WHERE event_id = ${id} ORDER BY id DESC LIMIT 1`) as unknown as { status: string; last_error: string }[]
    expect(build!.status).toBe('failed')
    expect(build!.last_error).toContain('rolled back')
    const alerts = (await audits('events.alert', 'events_worker', '0')).map((a) => a.detail.title)
    expect(alerts).toContain(`start of event ${id} failed — rolled back, Event station restored`)
    expect(alerts.some((t) => String(t).startsWith('EVENT STATION DOWN') && String(t).includes(`event ${id}`))).toBe(false)

    // bounded: no further restart for this event
    await new Promise((r) => setTimeout(r, 10_000))
    expect((await station14()).restarts.length - restartsBefore).toBe(2)
  })
})
