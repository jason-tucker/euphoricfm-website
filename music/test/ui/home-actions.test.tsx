// v0.3.1 home actions: the logged-in home page's action cards and summary
// cards, the My music action bar and requests section, the library's
// ?intent= banner and row buttons, and the song page's ?request= form.
// Server components are awaited and rendered with the data layer mocked.
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { navFor } from '@/components/Header'
import { parseIntent, requestHref } from '@/components/HomeActions'

type V = { userId: string; discordId: string; name: string; perms: Set<string> }
const state = vi.hoisted(() => ({ viewer: null as null | V }))
const q = vi.hoisted(() => ({
  memberSummary: vi.fn(async (_db: unknown, _v: unknown) => ({ inReview: 2, onAir: 5, openRequests: 1 })),
  reviewSummary: vi.fn(async (_db: unknown, _v: unknown) => ({ songs: 4, requests: 3 })),
  listOwnBatches: vi.fn(async () => []),
  listOwnRequests: vi.fn(async (): Promise<unknown[]> => []),
}))
const browse = vi.hoisted(() => ({
  PAGE_SIZE: 50,
  browseLibrary: vi.fn(async () => ({
    total: 1,
    page: 1,
    songs: [{ mediaId: 501, title: 'Night Song', fileName: 'x.mp3', artist: 'GRIM', album: 'Night', lengthS: 200, artUrl: null }],
  })),
  librarySong: vi.fn(async () => ({
    song: { mediaId: 501, title: 'Night Song', fileName: 'x.mp3', artist: 'GRIM', album: 'Night', genre: 'House', lengthS: 200, folder: 'GRIM', artUrl: null, playlistIds: null },
    myRequests: [],
    openRequests: 0,
  })),
}))

vi.mock('@/app/actions', () => ({ signInWithDiscord: vi.fn(), signOutAction: vi.fn() }))
vi.mock('@/server/db/client', () => ({ getDb: () => ({}) }))
vi.mock('@/server/ui/queries', () => q)
vi.mock('@/server/ui/browse', () => browse)
vi.mock('@/server/ui/settings', () => ({ uiSettings: async () => ({ assignablePlaylistIds: [], playlistNames: {} }) }))
vi.mock('@/server/http/route', () => ({ parseId: (s: string) => Number(s) }))
vi.mock('@/server/ui/page', () => ({
  headerViewer: async () => state.viewer,
  pageViewer: async () => state.viewer!,
  orNotFound: async <T,>(fn: () => Promise<T>) => fn(),
}))

const member: V = { userId: 'u1', discordId: '100000000000000001', name: 'Mia', perms: new Set(['submit', 'request']) }
const manager: V = { ...member, userId: 'u2', name: 'Max', perms: new Set(['submit', 'request', 'review', 'manage']) }
const sp = (o: Record<string, string> = {}) => Promise.resolve(o)
const hrefOf = (name: RegExp | string) => screen.getByRole('link', { name }).getAttribute('href')

beforeEach(() => {
  state.viewer = member
})

describe('home page (/)', async () => {
  const { default: Home } = await import('@/app/page')

  it('logged out: sign-in and the four steps, no action cards', async () => {
    state.viewer = null
    render(await Home())
    expect(screen.getByRole('button', { name: /sign in with discord/i })).toBeTruthy()
    expect(screen.queryByTestId('action-cards')).toBeNull()
    expect(screen.queryByTestId('how-it-works')).toBeNull()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toContain('Upload your MP3s or WAVs')
    expect(q.memberSummary).not.toHaveBeenCalled()
  })

  it('member: three large action cards, My music counts scoped to the viewer, no review card', async () => {
    render(await Home())
    expect(screen.getByRole('heading', { name: 'What do you want to do?' })).toBeTruthy()
    const cards = within(screen.getByTestId('action-cards')).getAllByRole('link')
    expect(cards.map((a) => a.getAttribute('href'))).toEqual(['/submit', '/library?intent=edit', '/library?intent=remove'])
    expect(screen.getByRole('heading', { name: 'Submit new songs' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Fix a song’s info or cover' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Ask to remove a song' })).toBeTruthy()
    expect(screen.getByText(/Upload MP3 or WAV files/)).toBeTruthy()

    const mine = screen.getByTestId('my-music-card')
    expect(mine.getAttribute('href')).toBe('/dashboard')
    expect(mine.textContent).toContain('2 in review · 5 on air · 1 open request')
    expect(q.memberSummary).toHaveBeenCalledWith(expect.anything(), member)
    expect(screen.queryByTestId('review-card')).toBeNull()
    expect(q.reviewSummary).not.toHaveBeenCalled()

    // The steps are still there, collapsed.
    const how = screen.getByTestId('how-it-works') as HTMLDetailsElement
    expect(how.tagName).toBe('DETAILS')
    expect(how.open).toBe(false)
    expect(within(how).getByText('How it works')).toBeTruthy()
    // A signed-in member is not told to sign in: three steps, numbered from 1.
    expect(within(how).queryByText('Sign in with Discord')).toBeNull()
    expect(within(how).getAllByRole('listitem')).toHaveLength(3)
    expect(within(how).getByText('Step 1').nextSibling?.textContent).toBe('Upload your MP3s or WAVs')
  })

  it('reviewer: highlighted review queue card with both counts', async () => {
    state.viewer = manager
    render(await Home())
    const card = screen.getByTestId('review-card')
    expect(card.getAttribute('href')).toBe('/review')
    expect(card.textContent).toContain('Review queue')
    expect(card.textContent).toContain('4 songs and 3 requests waiting')
    expect(q.memberSummary).toHaveBeenCalledWith(expect.anything(), manager)
  })

  it('reviewer: the card goes to the requests tab when only requests are waiting', async () => {
    state.viewer = manager
    q.reviewSummary.mockResolvedValueOnce({ songs: 0, requests: 1 })
    render(await Home())
    const card = screen.getByTestId('review-card')
    expect(card.getAttribute('href')).toBe('/review/requests')
    expect(card.textContent).toContain('0 songs and 1 request waiting')
  })
})

describe('My music (/dashboard)', async () => {
  const { default: Dashboard } = await import('@/app/dashboard/page')

  it('has the three actions as a bar and the counts', async () => {
    render(await Dashboard())
    const bar = screen.getByTestId('action-bar')
    expect(within(bar).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/submit', '/library?intent=edit', '/library?intent=remove'])
    expect(screen.getByTestId('dashboard-summary').textContent).toContain('2 in review · 5 on air · 1 open request')
  })

  it('the requests section is visible when empty, with an explanation and both request buttons', async () => {
    render(await Dashboard())
    expect(screen.getByRole('heading', { name: 'Your edit and removal requests' })).toBeTruthy()
    const empty = screen.getByTestId('no-requests')
    expect(empty.textContent).toMatch(/haven.t filed any requests/)
    expect(within(empty).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/library?intent=edit', '/library?intent=remove'])
  })

  it('lists open requests with status and ticket link', async () => {
    q.listOwnRequests.mockResolvedValueOnce([
      {
        id: 12,
        kind: 'edit',
        status: 'pending',
        mediaId: 501,
        targetPath: 'Music/Artists/GRIM/x.mp3',
        proposed: { title: 'Fixed' },
        reason: null,
        denyReason: null,
        error: null,
        awaitingArtist: false,
        artUrl: null,
        onLibrary: true,
        createdAt: '2026-09-27T00:00:00Z',
        ticket: { number: 77, webUrl: 'https://tickets.example/77', channelUrl: null, status: null },
      },
    ])
    render(await Dashboard())
    const list = screen.getByTestId('own-requests')
    expect(within(list).getByRole('link', { name: 'Edit request #12' }).getAttribute('href')).toBe('/library/501')
    expect(within(list).getByText('Pending review')).toBeTruthy()
    expect(within(list).getByRole('link', { name: /Ticket #77/ }).getAttribute('href')).toBe('https://tickets.example/77')
  })

  it('a request whose song is no longer in the library is not linked', async () => {
    q.listOwnRequests.mockResolvedValueOnce([
      {
        id: 13,
        kind: 'edit',
        status: 'denied',
        mediaId: 502,
        targetPath: 'Music/Artists/GRIM/y.mp3',
        proposed: null,
        reason: null,
        denyReason: 'Song was removed',
        error: null,
        awaitingArtist: false,
        artUrl: null,
        onLibrary: false,
        createdAt: '2026-09-27T00:00:00Z',
        ticket: null,
      },
    ])
    render(await Dashboard())
    const list = screen.getByTestId('own-requests')
    expect(within(list).getByText(/Edit request #13/)).toBeTruthy()
    expect(within(list).queryByRole('link', { name: /request #13/ })).toBeNull()
  })
})

describe('library intent (/library?intent=)', async () => {
  const { default: Library } = await import('@/app/library/page')

  it('intent=edit: banner, hidden intent in the search form, one "Suggest edit" button per row', async () => {
    const { container } = render(await Library({ searchParams: sp({ intent: 'edit' }) }))
    expect(screen.getByTestId('intent-banner').textContent).toContain('Pick the song you want to fix')
    expect((container.querySelector('input[name="intent"]') as HTMLInputElement).value).toBe('edit')
    expect(hrefOf('Suggest edit: Night Song')).toBe('/library/501?request=edit#request-form')
    expect(screen.queryByRole('link', { name: /Request removal/ })).toBeNull()
    // The whole row opens the form too.
    expect(screen.getByRole('link', { name: /Night Song.*GRIM/ }).getAttribute('href')).toBe('/library/501?request=edit#request-form')
  })

  it('intent=remove: removal banner and button', async () => {
    render(await Library({ searchParams: sp({ intent: 'remove' }) }))
    expect(screen.getByTestId('intent-banner').textContent).toContain('Pick the song you want removed')
    expect(hrefOf('Request removal: Night Song')).toBe('/library/501?request=remove#request-form')
    expect(screen.queryByRole('link', { name: /Suggest edit/ })).toBeNull()
  })

  it('no intent: no banner, both small buttons; unknown intents are ignored', async () => {
    render(await Library({ searchParams: sp({ intent: 'nope' }) }))
    expect(screen.queryByTestId('intent-banner')).toBeNull()
    expect(hrefOf('Suggest edit: Night Song')).toBe('/library/501?request=edit#request-form')
    expect(hrefOf('Request removal: Night Song')).toBe('/library/501?request=remove#request-form')
    expect(screen.getByRole('link', { name: /Night Song.*GRIM/ }).getAttribute('href')).toBe('/library/501')
  })

  it('a member without the request permission gets no request buttons', async () => {
    state.viewer = { ...member, perms: new Set(['submit']) }
    render(await Library({ searchParams: sp({ intent: 'edit' }) }))
    expect(screen.queryByTestId('intent-banner')).toBeNull()
    expect(screen.queryByRole('link', { name: /Suggest edit/ })).toBeNull()
  })
})

describe('song page (?request=)', async () => {
  const { default: SongPage } = await import('@/app/library/[mediaId]/page')
  const open = async (request?: string) =>
    render(await SongPage({ params: Promise.resolve({ mediaId: '501' }), searchParams: sp(request ? { request } : {}) }))

  it('request=remove opens the removal form under #request-form', async () => {
    const { container } = await open('remove')
    expect(container.querySelector('#request-form')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Ask to remove this song' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Request removal' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('button', { name: 'Send removal request' })).toBeTruthy()
  })

  it('request=edit (and no param) opens the edit form', async () => {
    await open('edit')
    expect(screen.getByRole('heading', { name: 'Fix this song’s info or cover' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Suggest an edit' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('nav and helpers', () => {
  it('members see Submit and "Edit or remove a song"; staff keep Review/Admin', () => {
    expect(navFor(new Set(['submit', 'request']))).toEqual([
      { href: '/dashboard', label: 'My music' },
      { href: '/submit', label: 'Submit' },
      { href: '/library', label: 'Edit or remove a song' },
    ])
    const staff = navFor(new Set(['submit', 'request', 'review', 'admin'])).map((i) => i.label)
    expect(staff).toEqual(['My music', 'Submit', 'Edit or remove a song', 'Review', 'Admin'])
  })
  it('parseIntent / requestHref', () => {
    expect(parseIntent('edit')).toBe('edit')
    expect(parseIntent('remove')).toBe('remove')
    expect(parseIntent(['edit'])).toBeNull()
    expect(parseIntent('removal')).toBeNull()
    expect(requestHref(9, 'remove')).toBe('/library/9?request=remove#request-form')
  })
})
