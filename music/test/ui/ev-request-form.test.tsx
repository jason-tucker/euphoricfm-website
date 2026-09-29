import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetConfigCache } from '@/events/components/hooks'
import { RequestForm } from '@/events/components/RequestForm'
import { HOUR, dateKey } from '@/events/components/time'
import { TzProvider } from '@/events/components/tz'
import { DEFAULT_CONFIG, type FullView } from '@/events/components/types'

// The one-page request form (0.5.3): every section on one page, a local
// backup that survives a reload, the draft created as soon as its minimum is
// valid, debounced + serialised saves, 409 re-apply, retries, inline upload
// and Submit flushing first.

// tus: a fake upload that "finishes" at once with a server URL.
vi.mock('tus-js-client', () => {
  class Upload {
    url: string | null = null
    constructor(
      readonly file: File,
      readonly opts: { onProgress?: (a: number, b: number) => void; onSuccess?: () => void },
    ) {}
    findPreviousUploads() {
      return Promise.resolve([])
    }
    resumeFromPreviousUpload() {}
    start() {
      this.opts.onProgress?.(5, 10)
      this.url = `/api/uploads/${'a'.repeat(32)}`
      this.opts.onSuccess?.()
    }
    abort() {
      return Promise.resolve()
    }
  }
  return { Upload }
})

const USER = '123456789012345678'
const cfg = { ...DEFAULT_CONFIG, eventsEnabled: true, uploadsEnabled: true }

type Reply = { status: number; body?: unknown }
type Handler = Reply | ((body: unknown, url: string) => Reply | Promise<Reply>)

// fetch mock with async handlers, call log and a concurrency counter.
function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body: unknown; keepalive: boolean }[] = []
  const state = { inFlight: 0, maxInFlight: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body, keepalive: !!init?.keepalive })
      const key = Object.keys(routes).find((k) => {
        const [m, p] = k.split(' ')
        return m === method && url.startsWith(p!)
      })
      const write = method !== 'GET' && !init?.keepalive
      if (write) state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight)
      try {
        const r = key ? routes[key]! : { status: 200, body: [] }
        const reply = typeof r === 'function' ? await r(body, url) : r
        return {
          ok: reply.status >= 200 && reply.status < 300,
          status: reply.status,
          headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
          json: async () => reply.body,
          text: async () => JSON.stringify(reply.body),
        }
      } finally {
        if (write) state.inFlight--
      }
    }),
  )
  return { calls, state, writes: () => calls.filter((c) => c.method !== 'GET' && !c.keepalive) }
}

function view(over: Partial<FullView> = {}): FullView {
  const start = Math.floor((Date.now() + 72 * HOUR) / HOUR) * HOUR
  return {
    kind: 'full',
    id: 42,
    ownerDiscordId: USER,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 2 * HOUR).toISOString(),
    status: 'draft',
    visibility: 'public',
    title: 'Club night',
    hostName: null,
    description: null,
    location: null,
    eventType: 'club_night',
    shortNotice: false,
    playlistOrder: 'shuffle',
    tracks: [{ position: 0, source: 'library', mediaId: 501, audioId: null, pinAt: null, label: { title: 'Midnight Drive', artist: 'Nova', lengthS: 200 } }],
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

const base = (c: typeof cfg = cfg): Record<string, Handler> => ({
  'GET /api/ev/config': { status: 200, body: c },
  'GET /api/ev/availability': { status: 200, body: [] },
  'GET /api/ev/audio': { status: 200, body: [] },
  'GET /api/ev/stingers': { status: 200, body: [{ mediaId: 9, path: 'EFM Stingers/id.mp3', title: 'EFM ID', lengthS: 12 }] },
  'GET /api/ev/library': { status: 200, body: [{ mediaId: 601, title: 'Neon Skyline', artist: 'Arc', lengthS: 240, artUrl: null }] },
})

function Form(p: { initial?: FullView; debounceMs?: number; staff?: boolean }) {
  return (
    <TzProvider>
      <RequestForm staff={!!p.staff} userKey={USER} chunkBytes={1024 * 1024} initial={p.initial} debounceMs={p.debounceMs ?? 60} retryBaseMs={30} />
    </TzProvider>
  )
}

const status = () => screen.getByTestId('rf-status-top').textContent ?? ''
const sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))

async function fillMinimum() {
  fireEvent.change(await screen.findByLabelText(/Event title/), { target: { value: 'Club night' } })
  fireEvent.change(screen.getByLabelText(/Kind of event/), { target: { value: 'club_night' } })
  const day = dateKey(Date.now() + 10 * 24 * HOUR, 'America/New_York')
  fireEvent.change(screen.getByLabelText(/^Date \(/), { target: { value: day } })
  fireEvent.change(screen.getByLabelText(/^Start time/), { target: { value: '20:00' } })
}

async function addLibrarySong() {
  fireEvent.change(screen.getByLabelText('Search the EuphoricFM library'), { target: { value: 'neon' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Add Neon Skyline' }, { timeout: 2000 }))
}

beforeEach(() => {
  resetConfigCache()
  window.localStorage.clear()
})
afterEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('one-page request form', () => {
  it('shows every section on one page with the save status', async () => {
    mockApi(base())
    render(<Form />)
    for (const name of ['Details', 'Date & time', 'Visibility', 'Songs', 'Announcements', 'Review & submit']) {
      expect(await screen.findByRole('heading', { level: 2, name })).toBeTruthy()
    }
    expect(screen.getByRole('link', { name: 'Songs' }).getAttribute('href')).toBe('#rf-songs')
    expect(screen.getByLabelText(/Event title/)).toBeTruthy()
    expect(screen.getByLabelText('Search the EuphoricFM library')).toBeTruthy()
    expect(screen.getByLabelText('Announcement')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeTruthy()
    expect(status()).toContain('Draft not saved yet — add a title, the kind of event, a date and start time, public or private.')
    expect(screen.getByTestId('rf-status-bottom').textContent).toContain('Draft not saved yet')
    // the top status is announced to screen readers
    expect(within(screen.getByTestId('rf-status-top')).getByRole('status').getAttribute('aria-live')).toBe('polite')
  })

  it('creates the draft only once the minimum is valid; before that the device backup holds everything', async () => {
    const api = mockApi({ ...base(), 'POST /api/ev/events': (b) => ({ status: 201, body: { event: { ...view({ tracks: [], version: 1 }), ...(b as object) } } }) })
    render(<Form />)
    fireEvent.change(await screen.findByLabelText(/Event title/), { target: { value: 'Club night' } })
    await sleep(200)
    expect(api.writes()).toHaveLength(0)
    expect(status()).toContain('add the kind of event, a date and start time, public or private')
    const saved = JSON.parse(window.localStorage.getItem(`efm_ev_form:${USER}:new`) ?? 'null')
    expect(saved.data.draft.title).toBe('Club night')

    await fillMinimum()
    await sleep(200)
    expect(api.writes()).toHaveLength(0)
    expect(status()).toContain('add public or private')
    fireEvent.click(screen.getByLabelText(/^Public/))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    const post = api.writes()[0]!
    expect(post.url).toBe('/api/ev/events')
    expect(post.body).toMatchObject({ title: 'Club night', eventType: 'club_night', visibility: 'public', playlistOrder: 'shuffle', enteredTz: 'America/New_York' })
    await waitFor(() => expect(status()).toContain('All changes saved ✓'))
    await sleep(200)
    expect(api.writes()).toHaveLength(1) // the server copy matches: nothing more to send
    // a reload now opens the draft itself
    expect(window.location.pathname).toBe('/my/events/42')
    // the backup moved off the "new" key once the draft existed and was saved
    expect(window.localStorage.getItem(`efm_ev_form:${USER}:new`)).toBeNull()
    expect(window.localStorage.getItem(`efm_ev_form:${USER}:42`)).toBeNull()
  })

  it('songs added and then a reload (unmount + remount) are still there, and are then saved', async () => {
    const v = view({ tracks: [] })
    const api = mockApi({ ...base(), 'PUT /api/ev/events/42/playlist': (b) => ({ status: 200, body: { event: { ...v, version: 4, tracks: (b as FullView).tracks } } }) })
    const first = render(<Form initial={v} debounceMs={60_000} />)
    await screen.findByRole('heading', { level: 2, name: 'Songs' })
    await addLibrarySong()
    expect(screen.getAllByTestId('pb-track')).toHaveLength(1)
    first.unmount() // the reload: nothing reached the server through the normal save
    expect(api.writes()).toHaveLength(0)

    render(<Form initial={v} />)
    expect(await screen.findByText(/We restored changes you made on this device/)).toBeTruthy()
    expect(screen.getAllByTestId('pb-track')).toHaveLength(1)
    expect(screen.getByText('Neon Skyline')).toBeTruthy()
    await waitFor(() => expect(api.writes().filter((c) => c.method === 'PUT')).toHaveLength(1))
    expect(api.writes()[0]!.body).toMatchObject({ version: 3, tracks: [{ position: 0, source: 'library', mediaId: 601, pinAt: null }] })
    await waitFor(() => expect(status()).toContain('All changes saved ✓'))
    expect(window.localStorage.getItem(`efm_ev_form:${USER}:42`)).toBeNull()
  })

  it('a restored new request can be started over (the device copy is dropped)', async () => {
    const api = mockApi(base())
    const first = render(<Form />)
    fireEvent.change(await screen.findByLabelText(/Event title/), { target: { value: 'Half typed' } })
    await waitFor(() => expect(window.localStorage.getItem(`efm_ev_form:${USER}:new`)).not.toBeNull())
    first.unmount()
    render(<Form />)
    expect(await screen.findByDisplayValue('Half typed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    await waitFor(() => expect((screen.getByLabelText(/Event title/) as HTMLInputElement).value).toBe(''))
    await sleep(150)
    expect(window.localStorage.getItem(`efm_ev_form:${USER}:new`)).toBeNull()
    expect(screen.queryByText(/We restored changes/)).toBeNull()
    expect(api.writes()).toHaveLength(0)
  })

  it('debounces, keeps one save in flight and coalesces edits made meanwhile', async () => {
    const v = view()
    let release: (() => void) | null = null
    let version = 3
    const api = mockApi({
      ...base(),
      'PATCH /api/ev/events/42': async (b) => {
        if (version === 3) await new Promise<void>((r) => (release = r))
        version++
        return { status: 200, body: { event: { ...v, ...(b as object), version } } }
      },
    })
    render(<Form initial={v} />)
    const title = await screen.findByLabelText(/Event title/)
    fireEvent.change(title, { target: { value: 'Club' } })
    fireEvent.change(title, { target: { value: 'Club nig' } })
    fireEvent.change(title, { target: { value: 'Club night!' } })
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0]!.body).toEqual({ title: 'Club night!', version: 3 })
    await waitFor(() => expect(status()).toContain('Saving…'))
    // edits while the first save is in flight: no second request yet
    fireEvent.change(title, { target: { value: 'Club night!!' } })
    fireEvent.change(screen.getByLabelText(/Where/), { target: { value: 'The Pier' } })
    await sleep(250)
    expect(api.writes()).toHaveLength(1)
    act(() => release!())
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[1]!.body).toEqual({ title: 'Club night!!', location: 'The Pier', version: 4 })
    expect(api.state.maxInFlight).toBe(1)
    await waitFor(() => expect(status()).toContain('All changes saved ✓'))
  })

  it('a 409 version_conflict re-fetches the event and re-applies the local change', async () => {
    const v = view()
    let patches = 0
    const api = mockApi({
      ...base(),
      'GET /api/ev/events/42': { status: 200, body: { ...v, version: 7, description: 'Set in another tab' } },
      'PATCH /api/ev/events/42': (b) =>
        ++patches === 1 ? { status: 409, body: { error: 'version_conflict' } } : { status: 200, body: { event: { ...v, ...(b as object), description: 'Set in another tab', version: 8 } } },
    })
    render(<Form initial={v} />)
    fireEvent.change(await screen.findByLabelText(/Event title/), { target: { value: 'Mine' } })
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[0]!.body).toMatchObject({ title: 'Mine', version: 3 })
    // our title again, on top of the other tab's version
    expect(api.writes()[1]!.body).toMatchObject({ title: 'Mine', version: 7 })
    await waitFor(() => expect(status()).toContain('All changes saved ✓'))
  })

  it('retries a transient failure with backoff and says so meanwhile', async () => {
    const v = view()
    let puts = 0
    let unblock: (() => void) | null = null
    const gate = new Promise<void>((r) => (unblock = r))
    const api = mockApi({
      ...base(),
      'PUT /api/ev/events/42/playlist': async (b) => {
        puts++
        if (puts === 1) return { status: 503, body: { error: 'unavailable' } }
        await gate
        return { status: 200, body: { event: { ...v, playlistOrder: (b as FullView).playlistOrder, version: 4 } } }
      },
    })
    render(<Form initial={v} />)
    fireEvent.click(await screen.findByRole('button', { name: 'In my order' }))
    await waitFor(() => expect(status()).toMatch(/Not saved: .* — retrying/))
    await waitFor(() => expect(puts).toBe(2))
    act(() => unblock!())
    await waitFor(() => expect(status()).toContain('All changes saved ✓'))
    expect(api.writes().map((c) => c.body)).toEqual([expect.objectContaining({ playlistOrder: 'sequential', version: 3 }), expect.objectContaining({ playlistOrder: 'sequential', version: 3 })])
  })

  it('a draft with playlist rule problems still saves; Submit is blocked with the reasons', async () => {
    const v = view()
    let version = 3
    const api = mockApi({
      ...base(),
      'PUT /api/ev/events/42/playlist': (b) => ({ status: 200, body: { event: { ...v, tracks: (b as FullView).tracks, version: ++version } } }),
      'PATCH /api/ev/events/42': (b) => ({ status: 200, body: { event: { ...v, ...(b as object), version: ++version } } }),
    })
    render(<Form initial={v} />)
    await screen.findAllByTestId('pb-track')
    // pin the song to the last allowed slot (end − 15 min)
    const pin = screen.getByLabelText('Pin to a time (optional)') as HTMLSelectElement
    const last = [...pin.options].map((o) => o.value).filter(Boolean).at(-1)!
    expect(Number(last)).toBe(Date.parse(v.endsAt) - 15 * 60_000)
    fireEvent.change(pin, { target: { value: last } })
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    // shorten the event: the pin is now too late, but the new time still saves
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: '90' } })
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[1]).toMatchObject({ method: 'PATCH', body: { endsAt: new Date(Date.parse(v.startsAt) + 90 * 60_000).toISOString(), version: 4 } })
    await waitFor(() => expect(status()).toContain('All changes saved ✓'))
    expect(screen.getByTestId('rf-problems').textContent).toMatch(/at least 15 minutes before it ends/)
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }))
    expect(screen.getByTestId('rf-blockers').textContent).toMatch(/at least 15 minutes before it ends/)
    await sleep(100)
    expect(api.writes().filter((c) => c.url.endsWith('/submit'))).toHaveLength(0)
  })

  it('Submit flushes the pending save first, then submits', async () => {
    const v = view()
    const api = mockApi({
      ...base(),
      'PATCH /api/ev/events/42': (b) => ({ status: 200, body: { event: { ...v, ...(b as object), version: 4 } } }),
      'POST /api/ev/events/42/submit': { status: 200, body: { event: { ...v, title: 'Final name', status: 'pending', version: 5 } } },
    })
    render(<Form initial={v} debounceMs={60_000} />)
    fireEvent.change(await screen.findByLabelText(/Event title/), { target: { value: 'Final name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }))
    expect(await screen.findByRole('heading', { name: 'Request sent' })).toBeTruthy()
    expect(api.writes().map((c) => `${c.method} ${c.url}`)).toEqual(['PATCH /api/ev/events/42', 'POST /api/ev/events/42/submit'])
    expect(api.writes()[0]!.body).toEqual({ title: 'Final name', version: 3 })
    expect(window.localStorage.getItem(`efm_ev_form:${USER}:42`)).toBeNull()
  })

  it('Submit with missing fields shows readable messages and sends nothing', async () => {
    const api = mockApi(base())
    render(<Form />)
    fireEvent.click(await screen.findByRole('button', { name: 'Submit request' }))
    expect(screen.getAllByText('Give your event a title.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Pick the kind of event.').length).toBeGreaterThan(0)
    expect(screen.getByTestId('rf-blockers').textContent).toMatch(/Pick public or private/)
    await sleep(150)
    expect(api.writes()).toHaveLength(0)
  })

  it('offline: says the changes are kept on this device', async () => {
    const v = view()
    mockApi({ ...base(), 'PATCH /api/ev/events/42': () => Promise.reject(new TypeError('Failed to fetch')) })
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      render(<Form initial={v} />)
      fireEvent.change(await screen.findByLabelText(/Event title/), { target: { value: 'No signal' } })
      await waitFor(() => expect(status()).toContain('Offline — saved on this device'))
      expect(JSON.parse(window.localStorage.getItem(`efm_ev_form:${USER}:42`)!).data.draft.title).toBe('No signal')
    } finally {
      online.mockRestore()
    }
  })

  it('leaving the page sends the unsaved changes with fetch keepalive', async () => {
    const v = view()
    const api = mockApi(base())
    render(<Form initial={v} debounceMs={60_000} />)
    fireEvent.change(await screen.findByLabelText(/Event title/), { target: { value: 'Last words' } })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    const k = api.calls.filter((c) => c.keepalive)
    expect(k).toHaveLength(1)
    expect(k[0]).toMatchObject({ method: 'PATCH', url: '/api/ev/events/42', body: { title: 'Last words', version: 3 } })
  })
})

describe('inline upload in the form', () => {
  const ready = { id: 77, kind: 'announcement', title: 'Welcome drop', artist: null, durationS: 8, status: 'ready', lastError: null, usedAt: null, expiresAt: null, createdAt: new Date().toISOString() }

  it('uploads an announcement, waits for Processing…, then selects it and adds it to the announcement being created', async () => {
    const v = view()
    let attached = false
    const api = mockApi({
      ...base(),
      'GET /api/ev/audio': () => ({ status: 200, body: attached ? [ready] : [] }),
      'POST /api/ev/audio': () => {
        attached = true
        return { status: 201, body: { audio: { ...ready, status: 'probing', durationS: null } } }
      },
      'PUT /api/ev/events/42/playlist': (b) => ({ status: 200, body: { event: { ...v, announcements: (b as FullView).announcements, version: 4 } } }),
    })
    render(<Form initial={v} />)
    // choose when it plays first
    const at = (await screen.findByLabelText('Plays at')) as HTMLSelectElement
    const slot = [...at.options].map((o) => o.value).filter(Boolean)[1]!
    fireEvent.change(at, { target: { value: slot } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload a new announcement' }))
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [new File(['id3'], 'welcome.mp3', { type: 'audio/mpeg' })] } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Welcome drop' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /I made this audio/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => expect((screen.getByLabelText('Announcement') as HTMLSelectElement).value).toBe('upload:77'))
    expect(api.writes().find((c) => c.url === '/api/ev/audio')!.body).toEqual({ uploadId: 'a'.repeat(32), kind: 'announcement', title: 'Welcome drop', artist: null })
    expect(screen.getByText(/"Welcome drop" is ready/)).toBeTruthy()
    // added with the chosen time, then autosaved
    expect(screen.getAllByTestId('pb-ann')).toHaveLength(1)
    await waitFor(() => expect(api.writes().filter((c) => c.method === 'PUT')).toHaveLength(1))
    expect(api.writes().find((c) => c.method === 'PUT')!.body).toMatchObject({
      announcements: [{ source: 'upload', audioId: 77, mediaId: null, mode: 'at', at: new Date(Number(slot)).toISOString() }],
    })
  })

  it('shows Processing… until the check finishes, and a rejected file says why', async () => {
    let polls = 0
    mockApi({
      ...base(),
      'GET /api/ev/audio': () => {
        polls++
        return { status: 200, body: polls > 2 ? [{ ...ready, status: 'rejected', lastError: 'too_short' }] : polls > 1 ? [{ ...ready, status: 'probing' }] : [] }
      },
      'POST /api/ev/audio': { status: 201, body: { audio: { ...ready, status: 'probing' } } },
    })
    render(<Form initial={view()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Upload a new announcement' }))
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [new File(['id3'], 'short.mp3', { type: 'audio/mpeg' })] } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Short' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /I made this audio/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText(/Processing…/)).toBeTruthy()
    expect(await screen.findByText(/announcements must be at least 3 seconds long/, {}, { timeout: 5000 })).toBeTruthy()
  })

  it('a song upload is added to the song list', async () => {
    const song = { ...ready, id: 88, kind: 'song', title: 'Our anthem', artist: 'The Hosts', durationS: 200 }
    let attached = false
    const api = mockApi({
      ...base(),
      'GET /api/ev/audio': () => ({ status: 200, body: attached ? [song] : [] }),
      'POST /api/ev/audio': () => {
        attached = true
        return { status: 201, body: { audio: { ...song, status: 'probing' } } }
      },
      'PUT /api/ev/events/42/playlist': (b) => ({ status: 200, body: { event: { ...view(), tracks: (b as FullView).tracks, version: 4 } } }),
    })
    render(<Form initial={view()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Upload a song' }))
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [new File(['id3'], 'anthem.mp3', { type: 'audio/mpeg' })] } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Our anthem' } })
    fireEvent.change(screen.getByLabelText('Artist'), { target: { value: 'The Hosts' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /I made this audio/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() => expect(screen.getAllByTestId('pb-track')).toHaveLength(2))
    await waitFor(() => expect(api.writes().filter((c) => c.method === 'PUT')).toHaveLength(1))
    expect(api.writes().find((c) => c.method === 'PUT')!.body).toMatchObject({ tracks: [{ mediaId: 501 }, { source: 'upload', audioId: 88 }] })
  })

  it('uploads switched off: a note instead of the buttons', async () => {
    mockApi(base({ ...cfg, uploadsEnabled: false }))
    render(<Form initial={view()} />)
    expect(await screen.findByTestId('iu-announcement-off')).toBeTruthy()
    expect(screen.getByTestId('iu-song-off')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Upload a new announcement' })).toBeNull()
  })

  it('My audio full: a friendly message instead of the button', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...ready, id: 100 + i }))
    mockApi({ ...base(), 'GET /api/ev/audio': { status: 200, body: many } })
    render(<Form initial={view()} />)
    expect((await screen.findAllByText(/Your My audio is full \(20 files\)/)).length).toBe(2)
    expect(screen.queryByRole('button', { name: 'Upload a new announcement' })).toBeNull()
  })
})
