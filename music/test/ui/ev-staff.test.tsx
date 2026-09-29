import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetConfigCache } from '@/events/components/hooks'
import { StaffQueueView } from '@/events/components/Staff'
import { TzProvider } from '@/events/components/tz'
import { DEFAULT_CONFIG, type FullView } from '@/events/components/types'
import { stubFetch } from './fetch'

// The staff queue names the requester (Discord snowflake as secondary text)
// and counts songs / announcements in the singular and plural.

const H = 3600_000

function view(over: Partial<FullView>): FullView {
  const start = Date.now() + 72 * H
  return {
    kind: 'full',
    id: 1,
    ownerDiscordId: '700000000000000001',
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 2 * H).toISOString(),
    status: 'pending',
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
    version: 1,
    denyReason: null,
    ownerName: null,
    ticketNumber: null,
    ...over,
  }
}

const track = (position: number) => ({ position, source: 'library' as const, mediaId: 500 + position, audioId: null, pinAt: null })

describe('staff queue rows', () => {
  beforeEach(() => resetConfigCache())

  it('shows the owner name with the snowflake, and pluralises the counts', async () => {
    stubFetch({
      'GET /api/ev/config': { status: 200, body: { ...DEFAULT_CONFIG, eventsEnabled: true } },
      'GET /api/ev/staff/queue': {
        status: 200,
        body: {
          pending: [view({ id: 1, title: 'One of each', ownerName: 'user0001', tracks: [track(0)] })],
          upcoming: [view({ id: 2, title: 'Nameless', status: 'approved', tracks: [track(0), track(1)] })],
        },
      },
    })
    render(
      <TzProvider>
        <StaffQueueView manage={false} />
      </TzProvider>,
    )
    const one = (await screen.findByText('One of each')).closest('a')!
    expect(one.textContent).toContain('Requested by user0001 (Discord 700000000000000001) · 1 song · 0 announcements')
    const two = screen.getByText('Nameless').closest('a')!
    expect(two.textContent).toContain('Requested by Discord user 700000000000000001 · 2 songs · 0 announcements')
  })
})
