import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { EventEditor, patchNeedsReapproval } from '@/events/components/EventEditor'
import { resetConfigCache } from '@/events/components/hooks'
import { TzProvider } from '@/events/components/tz'
import { DEFAULT_CONFIG, type FullView } from '@/events/components/types'
import { stubFetch } from './fetch'

// The editor's edit-conflict guard and the live-event restart confirmation:
// every save carries the loaded version, a 409 version_conflict reloads the
// event, and confirmRestart is only sent after the staff confirm dialog.

const OWNER = '123456789012345678'
const H = 3600_000
const cfg = { ...DEFAULT_CONFIG, eventsEnabled: true }

function view(over: Partial<FullView> = {}): FullView {
  const start = Date.now() + 72 * H
  return {
    kind: 'full',
    id: 42,
    ownerDiscordId: OWNER,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 2 * H).toISOString(),
    status: 'draft',
    visibility: 'public',
    title: 'Club night',
    hostName: null,
    description: null,
    location: null,
    eventType: 'club_night',
    shortNotice: false,
    playlistOrder: 'shuffle',
    tracks: [],
    announcements: [],
    ticketUrl: null,
    freezeAt: new Date(start - 30 * 60_000).toISOString(),
    canEdit: true,
    buildStatus: null,
    needsRebuild: false,
    version: 3,
    denyReason: null,
    ownerName: null,
    ticketNumber: null,
    ...over,
  }
}

const base = (v: FullView) => ({
  'GET /api/ev/config': { status: 200, body: cfg },
  'GET /api/ev/events/42': { status: 200, body: v },
  'GET /api/ev/audio': { status: 200, body: [] },
  'GET /api/ev/stingers': { status: 200, body: [] },
  'GET /api/ev/availability': { status: 200, body: [] },
})

describe('event editor: version guard and restart confirmation', () => {
  beforeEach(() => resetConfigCache())

  it('sends the loaded version; a 409 version_conflict reloads the event and says why', async () => {
    const v = view({ status: 'pending' })
    const calls = stubFetch({ ...base(v), 'PUT /api/ev/events/42/playlist': { status: 409, body: { error: 'version_conflict' } } })
    render(
      <TzProvider>
        <EventEditor id={42} staff={false} viewerDiscordId={OWNER} />
      </TzProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Save playlist' }))
    expect(await screen.findByText(/Someone else changed this event/)).toBeTruthy()
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body).toMatchObject({ version: 3 })
    expect(put.body).not.toHaveProperty('confirmRestart')
    // the event was fetched again (the reload), not just the first load
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/ev/events/42')).length).toBe(2))
  })

  it('live event: restart_required opens the staff confirmation; only then is confirmRestart sent', async () => {
    const now = Date.now()
    const v = view({ status: 'live', startsAt: new Date(now - H).toISOString(), endsAt: new Date(now + H).toISOString(), freezeAt: new Date(now - 90 * 60_000).toISOString() })
    const calls = stubFetch({
      ...base(v),
      'PUT /api/ev/events/42/playlist': (body) =>
        (body as { confirmRestart?: boolean }).confirmRestart === true ? { status: 200, body: { event: { ...v, version: 4 } } } : { status: 409, body: { error: 'restart_required' } },
    })
    render(
      <TzProvider>
        <EventEditor id={42} staff={true} viewerDiscordId="999999999999999999" />
      </TzProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Save playlist' }))
    const confirm = await screen.findByRole('button', { name: 'Restart and save', hidden: true })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    expect(calls[calls.length - 1]!.body).not.toHaveProperty('confirmRestart')
    fireEvent.click(confirm)
    expect(await screen.findByText('Playlist saved.')).toBeTruthy()
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(puts[1]!.body).toMatchObject({ version: 3, confirmRestart: true })
  })

  it('live event: cancelling the confirmation sends nothing more', async () => {
    const now = Date.now()
    const v = view({ status: 'live', startsAt: new Date(now - H).toISOString(), endsAt: new Date(now + H).toISOString(), freezeAt: new Date(now - 90 * 60_000).toISOString() })
    const calls = stubFetch({ ...base(v), 'PUT /api/ev/events/42/playlist': { status: 409, body: { error: 'restart_required' } } })
    render(
      <TzProvider>
        <EventEditor id={42} staff={true} viewerDiscordId="999999999999999999" />
      </TzProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Save playlist' }))
    await screen.findByRole('button', { name: 'Restart and save', hidden: true })
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel', hidden: true }).at(-1)!)
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })
})

describe('event editor: an own draft opens the one-page autosaving form', () => {
  beforeEach(() => {
    resetConfigCache()
    window.localStorage.clear()
  })

  it('own draft → RequestForm (no explicit save buttons); a pending request keeps explicit saves', async () => {
    stubFetch(base(view()))
    const r = render(
      <TzProvider>
        <EventEditor id={42} staff={false} viewerDiscordId={OWNER} chunkBytes={1024} />
      </TzProvider>,
    )
    expect(await screen.findByRole('heading', { level: 2, name: 'Review & submit' })).toBeTruthy()
    expect(screen.getByTestId('rf-status-top').textContent).toContain('All changes saved ✓')
    expect(screen.queryByRole('button', { name: 'Save playlist' })).toBeNull()
    r.unmount()
    stubFetch(base(view({ status: 'pending' })))
    render(
      <TzProvider>
        <EventEditor id={42} staff={false} viewerDiscordId={OWNER} chunkBytes={1024} />
      </TzProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Save playlist' })).toBeTruthy()
    expect(screen.queryByTestId('rf-status-top')).toBeNull()
  })
})

describe('event editor: saved playlist titles come from the server labels', () => {
  beforeEach(() => {
    resetConfigCache()
    window.localStorage.clear() // fresh session: no library-search memory
  })

  it("staff opening another member's event see real titles, artists and the length estimate", async () => {
    const v = view({
      tracks: [
        { position: 0, source: 'library', mediaId: 501, audioId: null, pinAt: null, label: { title: 'Midnight Drive', artist: 'Nova', lengthS: 3600 } },
        { position: 1, source: 'upload', mediaId: null, audioId: 77, pinAt: null, label: { title: 'Member mix', artist: null, lengthS: 3600 } },
      ],
      announcements: [
        { id: 9, source: 'upload', mediaId: null, audioId: 78, mode: 'every', at: null, everyMin: 30, from: null, until: null, label: { title: 'Welcome drop', artist: null, lengthS: 8 } },
      ],
    })
    const a = v.announcements[0]!
    a.from = v.startsAt
    a.until = v.endsAt
    // staff's own audio list does not hold the member's uploads
    stubFetch(base(v))
    render(
      <TzProvider>
        <EventEditor id={42} staff={true} viewerDiscordId="999999999999999999" />
      </TzProvider>,
    )
    expect(await screen.findByText('Midnight Drive')).toBeTruthy()
    expect(screen.getByText(/Nova · 1:00:00/)).toBeTruthy()
    expect(screen.getByText('Member mix')).toBeTruthy()
    expect(screen.getByText('Welcome drop')).toBeTruthy()
    expect(screen.queryByText(/Library song #/)).toBeNull()
    expect(screen.queryByText(/Upload #/)).toBeNull()
    expect(screen.getByTestId('pb-length').textContent).toBe('Songs: 2 h · Event: 2 h')
  })
})

describe('event editor: re-approval and rebuild notes', () => {
  beforeEach(() => resetConfigCache())

  it('title, time and visibility patches need re-approval; details do not', () => {
    expect(patchNeedsReapproval({ title: 'New name' })).toBe(true)
    expect(patchNeedsReapproval({ startsAt: 'x', endsAt: 'y' })).toBe(true)
    expect(patchNeedsReapproval({ visibility: 'private' })).toBe(true)
    expect(patchNeedsReapproval({ description: 'x', hostName: 'y', location: 'z', eventType: 'party' })).toBe(false)
  })

  it('a member renaming an approved event is asked to confirm re-approval first', async () => {
    const v = view({ status: 'approved' })
    const calls = stubFetch({ ...base(v), 'PATCH /api/ev/events/42': { status: 200, body: { event: { ...v, status: 'pending', title: 'Renamed', version: 4 } } } })
    render(
      <TzProvider>
        <EventEditor id={42} staff={false} viewerDiscordId={OWNER} />
      </TzProvider>,
    )
    expect(await screen.findByText(/Changing its title, songs, announcements, time or visibility/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Event title/), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const confirm = await screen.findByRole('button', { name: 'Save and send for re-approval', hidden: true })
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
    fireEvent.click(confirm)
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1))
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ title: 'Renamed', version: 3 })
  })

  it('the owner is told staff will reload changes when the build is stale', async () => {
    stubFetch(base(view({ status: 'built', needsRebuild: true })))
    render(
      <TzProvider>
        <EventEditor id={42} staff={false} viewerDiscordId={OWNER} />
      </TzProvider>,
    )
    expect(await screen.findByText(/Staff will reload your changes into the station/)).toBeTruthy()
  })

  it('no rebuild note when the build is current', async () => {
    stubFetch(base(view({ status: 'built', needsRebuild: false })))
    render(
      <TzProvider>
        <EventEditor id={42} staff={false} viewerDiscordId={OWNER} />
      </TzProvider>,
    )
    await screen.findByRole('button', { name: 'Save playlist' })
    expect(screen.queryByText(/Staff will reload your changes/)).toBeNull()
  })
})
