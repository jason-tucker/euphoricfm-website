import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { EventEditor } from '@/events/components/EventEditor'
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
    const v = view()
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
