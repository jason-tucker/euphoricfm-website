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

/** A logged body without the per-save guards (`raw` keeps them). */
function stripGuards(b: unknown): unknown {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b
  const { expectStatus: _e, saveId: _s, ...rest } = b as Record<string, unknown>
  return rest
}

// fetch mock with async handlers, call log and a concurrency counter.
function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body: unknown; raw: unknown; keepalive: boolean }[] = []
  const state = { inFlight: 0, maxInFlight: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body: stripGuards(body), raw: body, keepalive: !!init?.keepalive })
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
    // the owner's GET lists the latest save ids (none recorded yet)
    recentSaveIds: [],
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
/** The device copies of a draft (one per tab). */
const draftBackupKeys = (id = 42) => Object.keys(window.localStorage).filter((k) => k.startsWith(`efm_ev_form:${USER}:${id}~`))
const draftBackup = (id = 42) => {
  const k = draftBackupKeys(id)
  return k.length ? JSON.parse(window.localStorage.getItem(k[0]!)!) : null
}
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
    expect(draftBackupKeys()).toEqual([])
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
    expect(draftBackupKeys()).toEqual([])
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
    expect(draftBackupKeys()).toEqual([])
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
      expect(draftBackup().data.draft.title).toBe('No signal')
      // the copy records the server version it was made against (for the merge on restore)
      expect(draftBackup()).toMatchObject({ v: 2, eventId: 42, baseVersion: 3, base: { version: 3 } })
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

// ------------------------------------------------------------ two tabs ----
// A fake server for one draft: version-checked PATCH / PUT like the real API
// (409 version_conflict on a stale version, +1 per accepted edit).
const SONGS: Record<number, { title: string; artist: string; lengthS: number }> = {
  701: { title: 'Alpha', artist: 'A', lengthS: 200 },
  702: { title: 'Bravo', artist: 'B', lengthS: 210 },
  703: { title: 'Charlie', artist: 'C', lengthS: 220 },
}
const lib = (mediaId: number, position: number, pinAt: string | null = null) => ({
  position,
  source: 'library' as const,
  mediaId,
  audioId: null,
  pinAt,
  label: SONGS[mediaId],
})

function fakeServer(start: FullView) {
  const srv = { state: start }
  const routes: Record<string, Handler> = {
    ...base(),
    'GET /api/ev/library': (_b, url) => {
      const q = decodeURIComponent(url.split('q=')[1] ?? '').toLowerCase()
      return { status: 200, body: Object.entries(SONGS).filter(([, s]) => s.title.toLowerCase().includes(q)).map(([id, s]) => ({ mediaId: Number(id), ...s, artUrl: null })) }
    },
    'GET /api/ev/events/42': () => ({ status: 200, body: srv.state }),
    'PATCH /api/ev/events/42': (b) => {
      const { version, expectStatus, saveId, ...fields } = b as { version: number; expectStatus?: string; saveId?: string } & Record<string, unknown>
      if (expectStatus !== undefined && expectStatus !== srv.state.status) return { status: 409, body: { error: 'status_changed', status: srv.state.status } }
      if (version !== srv.state.version) return { status: 409, body: { error: 'version_conflict' } }
      srv.state = { ...srv.state, ...(fields as Partial<FullView>), version: srv.state.version + 1, recentSaveIds: [...(saveId ? [saveId] : []), ...(srv.state.recentSaveIds ?? [])] }
      return { status: 200, body: { event: srv.state } }
    },
    'PUT /api/ev/events/42/playlist': (b) => {
      const p = b as { version: number; expectStatus?: string; saveId?: string; tracks: FullView['tracks']; announcements: FullView['announcements']; playlistOrder: FullView['playlistOrder'] }
      if (p.expectStatus !== undefined && p.expectStatus !== srv.state.status) return { status: 409, body: { error: 'status_changed', status: srv.state.status } }
      if (p.version !== srv.state.version) return { status: 409, body: { error: 'version_conflict' } }
      srv.state = {
        ...srv.state,
        recentSaveIds: [...(p.saveId ? [p.saveId] : []), ...(srv.state.recentSaveIds ?? [])],
        tracks: p.tracks.map((t) => ({ ...t, label: t.mediaId ? SONGS[t.mediaId] : undefined })),
        announcements: p.announcements,
        playlistOrder: p.playlistOrder,
        version: srv.state.version + 1,
      }
      return { status: 200, body: { event: srv.state } }
    },
  }
  return { srv, routes }
}

async function addSong(title: string) {
  fireEvent.change(screen.getByLabelText('Search the EuphoricFM library'), { target: { value: title.toLowerCase() } })
  fireEvent.click(await screen.findByRole('button', { name: `Add ${title}` }, { timeout: 2000 }))
}
const trackTitles = () => screen.getAllByTestId('pb-track').map((li) => (['Alpha', 'Bravo', 'Charlie', 'Neon Skyline', 'Midnight Drive'].find((t) => li.textContent?.includes(t)) ?? '?'))

describe('two tabs on one draft', () => {
  const v2 = () => view({ version: 2, tracks: [lib(701, 0)] })

  it('a stale tab merges the other tab\'s saved work instead of writing over it (host + Bravo from A, location + Charlie from B)', async () => {
    const { srv, routes } = fakeServer(v2())
    const api = mockApi(routes)
    // Tab A: sets the host and adds Bravo; both save.
    const a = render(<Form initial={v2()} />)
    fireEvent.change(await screen.findByLabelText(/Hosted by/), { target: { value: 'Host From A' } })
    await addSong('Bravo')
    await waitFor(() => expect(srv.state.version).toBe(4))
    await waitFor(() => expect(status()).toContain('All changes saved ✓'))
    expect(srv.state.hostName).toBe('Host From A')
    a.unmount()
    // Tab B was opened before A saved (still holds version 2) and never refreshed.
    const before = api.writes().length
    render(<Form initial={v2()} />)
    fireEvent.change(await screen.findByLabelText(/Where/), { target: { value: 'The Pier' } })
    // the merge is named (what came in from the other tab)
    await waitFor(() => expect(screen.getByTestId('rf-merge-note').textContent).toBe('Merged changes made in another tab: host name → "Host From A" and added "Bravo".'))
    await addSong('Charlie')
    await waitFor(() => expect(status()).toContain('All changes saved ✓'), { timeout: 3000 })
    await sleep(150)
    // the server has everything: A's host and Bravo, B's location and Charlie
    expect(srv.state).toMatchObject({ hostName: 'Host From A', location: 'The Pier' })
    expect(srv.state.tracks.map((t) => t.label?.title)).toEqual(['Alpha', 'Bravo', 'Charlie'])
    // B's first save hit the 409; after the merge it sent only its own fields
    const bWrites = api.writes().slice(before)
    expect(bWrites[0]).toMatchObject({ method: 'PATCH', body: { location: 'The Pier', version: 2 } })
    const patches = bWrites.filter((c) => c.method === 'PATCH')
    expect(patches.at(-1)!.body).toEqual({ location: 'The Pier', version: 4 })
    for (const c of patches) expect(c.body).not.toHaveProperty('hostName')
    // B's form shows the merged state, with a short note
    expect((screen.getByLabelText(/Hosted by/) as HTMLInputElement).value).toBe('Host From A')
    expect(trackTitles()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    // the next save (Charlie) merged nothing: the note is gone
    await waitFor(() => expect(screen.queryByTestId('rf-merge-note')).toBeNull())
    // every save carried the draft status guard and its own saveId
    for (const c of bWrites) expect(c.raw).toMatchObject({ expectStatus: 'draft', saveId: expect.stringMatching(/^[A-Za-z0-9-]{8,64}$/) })
    expect(new Set(bWrites.map((c) => (c.raw as { saveId: string }).saveId)).size).toBe(bWrites.length)
  })

  it('a field both tabs changed keeps this tab\'s value and says so', async () => {
    const { srv, routes } = fakeServer(view({ version: 2 }))
    mockApi(routes)
    srv.state = { ...srv.state, hostName: 'Other tab host', description: 'Other tab text', version: 3 }
    render(<Form initial={view({ version: 2 })} />)
    fireEvent.change(await screen.findByLabelText(/Hosted by/), { target: { value: 'My host' } })
    await waitFor(() => expect(srv.state.version).toBe(4))
    expect(srv.state).toMatchObject({ hostName: 'My host', description: 'Other tab text' })
    expect((screen.getByLabelText(/Description/) as HTMLTextAreaElement).value).toBe('Other tab text')
    expect(screen.getByTestId('rf-merge-note').textContent).toBe('Merged changes made in another tab: description → "Other tab text". Kept this tab\'s host name.')
  })

  it('a stale tab catches up when it comes back into view (no request of its own), and later edits go on top', async () => {
    const { srv, routes } = fakeServer(v2())
    const api = mockApi(routes)
    render(<Form initial={v2()} />)
    await screen.findAllByTestId('pb-track')
    // meanwhile another tab saved a host and a second song
    srv.state = { ...srv.state, hostName: 'Host From A', tracks: [lib(701, 0), lib(702, 1)], version: 4 }
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect((screen.getByLabelText(/Hosted by/) as HTMLInputElement).value).toBe('Host From A'))
    expect(trackTitles()).toEqual(['Alpha', 'Bravo'])
    await sleep(200)
    expect(api.writes()).toHaveLength(0) // nothing of its own to send
    expect(draftBackupKeys()).toEqual([])
    // an edit now goes on top of version 4 and sends only that field
    fireEvent.change(screen.getByLabelText(/Where/), { target: { value: 'The Pier' } })
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0]!.body).toEqual({ location: 'The Pier', version: 4 })
    expect(srv.state).toMatchObject({ hostName: 'Host From A', location: 'The Pier', version: 5 })
    expect(srv.state.tracks).toHaveLength(2)
  })

  it("another tab's device copy changing (it saved) makes this tab re-read the draft", async () => {
    const { srv, routes } = fakeServer(v2())
    const api = mockApi(routes)
    render(<Form initial={v2()} />)
    await screen.findAllByTestId('pb-track')
    srv.state = { ...srv.state, title: 'Renamed elsewhere', version: 3 }
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: `efm_ev_form:${USER}:42~othertab`, newValue: null }))
    })
    await waitFor(() => expect((screen.getByLabelText(/Event title/) as HTMLInputElement).value).toBe('Renamed elsewhere'), { timeout: 3000 })
    // an unrelated key does nothing
    const gets = api.calls.filter((c) => c.method === 'GET' && c.url === '/api/ev/events/42').length
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'efm_tz', newValue: 'local' }))
    })
    await sleep(1000)
    expect(api.calls.filter((c) => c.method === 'GET' && c.url === '/api/ev/events/42')).toHaveLength(gets)
    expect(api.writes()).toHaveLength(0)
  })

  it('submitted in another tab: this tab stops autosaving instead of editing the pending request', async () => {
    const { srv, routes } = fakeServer(v2())
    const api = mockApi(routes)
    render(<Form initial={v2()} />)
    srv.state = { ...srv.state, status: 'pending', version: 3 }
    fireEvent.change(await screen.findByLabelText(/Where/), { target: { value: 'Late change' } })
    await waitFor(() => expect(status()).toContain('This request was submitted in another tab or on another device'))
    expect(api.writes()).toHaveLength(1) // the refused PATCH only
    expect(srv.state.location).toBeNull()
  })

  it('a device copy made against an older version is merged into the newer server copy on load, never written over it', async () => {
    const v3 = view({ version: 3, tracks: [lib(701, 0)] })
    // this device: location + Charlie against version 3, never sent (the page was closed)
    const first = render(<Form initial={v3} debounceMs={60_000} />)
    mockApi(fakeServer(v3).routes)
    fireEvent.change(await screen.findByLabelText(/Where/), { target: { value: 'The Pier' } })
    await addSong('Charlie')
    await waitFor(() => expect(draftBackup()?.data.builder.tracks).toHaveLength(2))
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))) // the keepalive never arrives
    first.unmount()
    expect(draftBackupKeys()).toHaveLength(1)
    // meanwhile another tab saved a host and Bravo (version 5)
    const v5 = view({ version: 5, hostName: 'Host From A', tracks: [lib(701, 0), lib(702, 1)] })
    const { srv, routes } = fakeServer(v5)
    const api = mockApi(routes)
    render(<Form initial={v5} />)
    expect(await screen.findByText(/We restored changes you made on this device/)).toBeTruthy()
    expect((screen.getByLabelText(/Hosted by/) as HTMLInputElement).value).toBe('Host From A')
    expect((screen.getByLabelText(/Where/) as HTMLInputElement).value).toBe('The Pier')
    expect(trackTitles()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    await waitFor(() => expect(srv.state.version).toBe(7))
    expect(api.writes()[0]!.body).toEqual({ location: 'The Pier', version: 5 })
    expect(srv.state).toMatchObject({ hostName: 'Host From A', location: 'The Pier' })
    expect(srv.state.tracks.map((t) => t.label?.title)).toEqual(['Alpha', 'Bravo', 'Charlie'])
    // saved: the device copy is gone
    await waitFor(() => expect(draftBackupKeys()).toEqual([]))
  })

  it('a device copy whose changes already reached the server (the keepalive arrived) restores nothing and is dropped', async () => {
    const v3 = view({ version: 3, tracks: [lib(701, 0)] })
    const first = render(<Form initial={v3} debounceMs={60_000} />)
    mockApi(fakeServer(v3).routes)
    await addSong('Charlie')
    await waitFor(() => expect(draftBackup()?.data.builder.tracks).toHaveLength(2))
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    first.unmount()
    const v4 = view({ version: 4, tracks: [lib(701, 0), lib(703, 1)] })
    const api = mockApi(fakeServer(v4).routes)
    render(<Form initial={v4} />)
    await screen.findAllByTestId('pb-track')
    await sleep(200)
    expect(trackTitles()).toEqual(['Alpha', 'Charlie'])
    expect(screen.queryByText(/We restored changes/)).toBeNull()
    expect(api.writes()).toHaveLength(0)
    expect(draftBackupKeys()).toEqual([])
  })

  it('the keepalive on leaving sends only this tab\'s changed fields, against its base version', async () => {
    const { srv, routes } = fakeServer(v2())
    const api = mockApi(routes)
    render(<Form initial={v2()} debounceMs={60_000} />)
    srv.state = { ...srv.state, hostName: 'Host From A', version: 3 }
    fireEvent.change(await screen.findByLabelText(/Where/), { target: { value: 'The Pier' } })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    const k = api.calls.filter((c) => c.keepalive)
    expect(k).toEqual([expect.objectContaining({ method: 'PATCH', body: { location: 'The Pier', version: 2 } })])
    // the stale version is refused (409) and the device copy keeps the change for the next load's merge
    expect(srv.state.location).toBeNull()
    expect(draftBackup().data.draft.location).toBe('The Pier')
  })
})

describe('uploads being ingested', () => {
  const item = { id: 91, kind: 'song', title: 'Fresh mix', artist: 'Me', durationS: 200, status: 'ingesting', lastError: null, usedAt: null, expiresAt: null, createdAt: new Date().toISOString() }

  it('an upload in ingesting is usable at once: added and saved', async () => {
    let attached = false
    const api = mockApi({
      ...base(),
      'GET /api/ev/audio': () => ({ status: 200, body: attached ? [item] : [] }),
      'POST /api/ev/audio': () => {
        attached = true
        return { status: 201, body: { audio: { ...item, status: 'probing', durationS: null } } }
      },
      'PUT /api/ev/events/42/playlist': (b) => ({ status: 200, body: { event: { ...view(), tracks: (b as FullView).tracks, version: 4 } } }),
    })
    render(<Form initial={view()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Upload a song' }))
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [new File(['id3'], 'mix.mp3', { type: 'audio/mpeg' })] } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fresh mix' } })
    fireEvent.change(screen.getByLabelText('Artist'), { target: { value: 'Me' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /I made this audio/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText(/"Fresh mix" is ready and added to your songs/)).toBeTruthy()
    await waitFor(() => expect(status()).toContain('All changes saved ✓'))
    expect(api.writes().find((c) => c.method === 'PUT')!.body).toMatchObject({ tracks: [{ mediaId: 501 }, { source: 'upload', audioId: 91 }] })
  })

  it('a save refused as audio_not_ready keeps the pick and retries by itself until the upload is usable', async () => {
    let puts = 0
    const api = mockApi({
      ...base(),
      'GET /api/ev/audio': { status: 200, body: [item] },
      'PUT /api/ev/events/42/playlist': (b) =>
        ++puts <= 2 ? { status: 400, body: { error: 'audio_not_ready' } } : { status: 200, body: { event: { ...view(), tracks: (b as FullView).tracks, version: 4 } } },
    })
    render(<Form initial={view()} />)
    // an ingesting upload is listed under My audio (selectable) like a ready one
    const row = (await screen.findByText(/Fresh mix/)).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(status()).toContain('One of your uploads is still being checked'))
    expect(status()).toContain('retrying')
    await waitFor(() => expect(status()).toContain('All changes saved ✓'), { timeout: 3000 })
    expect(puts).toBe(3)
    expect(api.writes().every((c) => (c.body as { tracks: unknown[] }).tracks.length === 2)).toBe(true)
    expect(screen.getAllByTestId('pb-track')).toHaveLength(2)
  })
})

// ------------------------------------------------------- fix round 2 ----
describe('status guard: a stale draft tab never edits a submitted request', () => {
  const v2 = () => view({ version: 2, tracks: [lib(701, 0)] })

  it('fi: submitted and approved elsewhere (version unchanged): catching up stops the tab, later edits send nothing', async () => {
    const { srv, routes } = fakeServer(v2())
    const api = mockApi(routes)
    render(<Form initial={v2()} />)
    await screen.findAllByTestId('pb-track')
    // tab A pressed Submit, staff approved: neither bumps the version
    srv.state = { ...srv.state, status: 'approved' }
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(status()).toContain('This request was submitted and approved in another tab or on another device, so this page no longer saves.'))
    expect(status()).toContain('Nothing on this page was lost.')
    expect(screen.getByRole('link', { name: 'Reload the request' }).getAttribute('href')).toBe('/my/events/42')
    // B edits the title and adds Charlie; no Save pressed: nothing is sent
    fireEvent.change(screen.getByLabelText(/Event title/), { target: { value: 'Changed in B' } })
    await addSong('Charlie')
    await sleep(500)
    expect(api.writes()).toHaveLength(0)
    expect(srv.state).toMatchObject({ status: 'approved', version: 2, title: 'Club night' })
    expect(srv.state.tracks).toHaveLength(1)
    expect(status()).not.toContain('All changes saved')
  })

  it('fh: submitted elsewhere, no catch-up first: the server refuses (status_changed), the saver stops for good and says the change was NOT saved', async () => {
    const { srv, routes } = fakeServer(v2())
    const api = mockApi(routes)
    render(<Form initial={v2()} />)
    srv.state = { ...srv.state, status: 'pending' } // same version
    fireEvent.change(await screen.findByLabelText(/Where/), { target: { value: 'Place From B' } })
    await waitFor(() => expect(status()).toContain('This request was submitted in another tab or on another device'))
    expect(status()).toContain('Your latest changes on this page were NOT saved.')
    expect(api.writes()).toHaveLength(1)
    expect(api.writes()[0]!.raw).toMatchObject({ location: 'Place From B', version: 2, expectStatus: 'draft' })
    // terminal: no retries, and later edits are not sent either
    await addSong('Charlie')
    await sleep(500)
    expect(api.writes()).toHaveLength(1)
    expect(srv.state).toMatchObject({ status: 'pending', version: 2, location: null })
  })

  it('Discard on a stale tab never withdraws a request submitted meanwhile', async () => {
    const { srv, routes } = fakeServer(v2())
    const api = mockApi({
      ...routes,
      'POST /api/ev/events/42/withdraw': (b) =>
        (b as { expectStatus?: string }).expectStatus !== srv.state.status ? { status: 409, body: { error: 'status_changed', status: srv.state.status } } : { status: 200, body: { event: srv.state } },
    })
    render(<Form initial={v2()} />)
    srv.state = { ...srv.state, status: 'pending' }
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(status()).toContain('It was not discarded here.'))
    expect(api.writes().find((c) => c.url.endsWith('/withdraw'))!.raw).toEqual({ expectStatus: 'draft' })
    expect(srv.state.status).toBe('pending')
  })
})

describe('keepalive leftovers never overwrite newer work', () => {
  const v4 = () => view({ version: 4, tracks: [lib(701, 0), lib(703, 1)] })

  /** PC: host "PC host" and Charlie removed, then the tab closes at once (keepalive). */
  async function pcCloses(arrives: boolean) {
    const { srv, routes } = fakeServer(v4())
    mockApi(routes)
    const pc = render(<Form initial={v4()} debounceMs={60_000} />)
    fireEvent.change(await screen.findByLabelText(/Hosted by/), { target: { value: 'PC host' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Charlie' }))
    await waitFor(() => expect(draftBackup()?.data.builder.tracks).toHaveLength(1))
    if (!arrives) vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    pc.unmount()
    return srv
  }

  it('fd2: the keepalive arrived, the phone changed the host and added Charlie back: reopening restores nothing and keeps the phone\'s work', async () => {
    const srv = await pcCloses(true)
    expect(srv.state).toMatchObject({ hostName: 'PC host', version: 6 })
    expect(srv.state.tracks.map((t) => t.label?.title)).toEqual(['Alpha'])
    const copy = draftBackup()
    expect(copy.keepalive).toHaveLength(1) // one record, even though pagehide and the unmount both flushed
    // the phone (another device) saves after that
    srv.state = { ...srv.state, hostName: 'Phone host', tracks: [lib(701, 0), lib(703, 1)], version: 8, recentSaveIds: ['phone-save-2', 'phone-save-1', ...(srv.state.recentSaveIds ?? [])] }
    const api = mockApi(fakeServer(srv.state).routes)
    render(<Form initial={srv.state} />)
    await screen.findAllByTestId('pb-track')
    await sleep(400)
    expect(screen.queryByText(/We restored changes/)).toBeNull()
    expect(screen.queryByTestId('rf-restore-ask')).toBeNull()
    expect((screen.getByLabelText(/Hosted by/) as HTMLInputElement).value).toBe('Phone host')
    expect(trackTitles()).toEqual(['Alpha', 'Charlie'])
    expect(api.writes()).toHaveLength(0)
    expect(draftBackupKeys()).toEqual([])
  })

  it('a keepalive that did NOT arrive still restores (server unchanged) and saves', async () => {
    await pcCloses(false)
    expect(draftBackup().keepalive).toHaveLength(1)
    const { srv, routes } = fakeServer(v4())
    const api = mockApi(routes)
    render(<Form initial={v4()} />)
    expect((await screen.findByText(/We restored changes you made on this device/)).textContent).toContain('host name → "PC host" and removed "Charlie"')
    await waitFor(() => expect(srv.state.version).toBe(6))
    expect(srv.state.hostName).toBe('PC host')
    expect(srv.state.tracks.map((t) => t.label?.title)).toEqual(['Alpha'])
    expect(api.writes()[0]!.body).toEqual({ hostName: 'PC host', version: 4 })
    await waitFor(() => expect(draftBackupKeys()).toEqual([]))
  })

  async function staleConflict() {
    await pcCloses(false)
    // meanwhile the phone changed the host (the PC's keepalive never arrived)
    const phone = view({ version: 6, hostName: 'Phone host', tracks: [lib(701, 0), lib(703, 1)], recentSaveIds: ['phone-save-2', 'phone-save-1'] })
    const { srv, routes } = fakeServer(phone)
    const api = mockApi(routes)
    render(<Form initial={phone} />)
    const ask = await screen.findByTestId('rf-restore-ask')
    expect(within(ask).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['host name → "PC host"', 'removed "Charlie"'])
    expect(status()).toContain('Not saving yet')
    // nothing is sent (not even a catch-up) until a choice is made
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await sleep(400)
    expect(api.calls.filter((c) => c.url.startsWith('/api/ev/events/42'))).toHaveLength(0)
    expect((screen.getByLabelText(/Hosted by/) as HTMLInputElement).value).toBe('Phone host')
    return { srv, api }
  }

  it('a restore that would overwrite newer work asks first; "Keep the saved version" drops the copy and sends nothing', async () => {
    const { srv, api } = await staleConflict()
    fireEvent.click(screen.getByRole('button', { name: 'Keep the saved version' }))
    await sleep(300)
    expect(screen.queryByTestId('rf-restore-ask')).toBeNull()
    expect(api.writes()).toHaveLength(0)
    expect(draftBackupKeys()).toEqual([])
    expect(srv.state).toMatchObject({ hostName: 'Phone host', version: 6 })
    expect(trackTitles()).toEqual(['Alpha', 'Charlie'])
    expect(status()).toContain('All changes saved')
  })

  it('"Restore these changes" applies them and saves', async () => {
    const { srv, api } = await staleConflict()
    fireEvent.click(screen.getByRole('button', { name: 'Restore these changes' }))
    await waitFor(() => expect(srv.state.version).toBe(8))
    expect(api.writes()[0]!.body).toEqual({ hostName: 'PC host', version: 6 })
    expect(srv.state.tracks.map((t) => t.label?.title)).toEqual(['Alpha'])
    await waitFor(() => expect(draftBackupKeys()).toEqual([]))
  })
})

describe('an upload that failed its check', () => {
  const broken = { id: 91, kind: 'song', title: 'Broken mix', artist: 'Me', durationS: 200, status: 'failed', lastError: 'too quiet', usedAt: null, expiresAt: null, createdAt: new Date().toISOString() }
  const withBroken = () =>
    view({ tracks: [view().tracks[0]!, { position: 1, source: 'upload', mediaId: null, audioId: 91, pinAt: null, label: { title: 'Broken mix', artist: 'Me', lengthS: 200 } }] })

  it('is marked, is not waited for (no retry loop), and the details still save; removing it saves the rest', async () => {
    let v = withBroken()
    let puts = 0
    const api = mockApi({
      ...base(),
      'GET /api/ev/audio': { status: 200, body: [broken] },
      'PATCH /api/ev/events/42': (b) => {
        const { version: _v, expectStatus: _e, saveId: _s, ...f } = b as Record<string, unknown>
        v = { ...v, ...(f as Partial<FullView>), version: v.version + 1 }
        return { status: 200, body: { event: v } }
      },
      'PUT /api/ev/events/42/playlist': (b) => {
        puts++
        const p = b as FullView
        if (p.tracks.some((t) => t.audioId === 91)) return { status: 400, body: { error: 'audio_failed', audioId: 91 } }
        v = { ...v, tracks: p.tracks, version: v.version + 1 }
        return { status: 200, body: { event: v } }
      },
    })
    render(<Form initial={withBroken()} debounceMs={1000} />)
    // one save with a details change and a playlist change
    fireEvent.change(await screen.findByLabelText(/Hosted by/), { target: { value: 'New host' } })
    await addLibrarySong()
    await waitFor(() => expect(status()).toContain('Not saved: "Broken mix" failed its check. Remove it to save the rest.'), { timeout: 4000 })
    expect(status()).not.toContain('retrying')
    // the details went first and are saved
    expect(api.writes()[0]).toMatchObject({ method: 'PATCH', body: { hostName: 'New host', version: 3 } })
    expect(v.hostName).toBe('New host')
    const row = screen.getAllByTestId('pb-track').find((li) => li.textContent?.includes('Broken mix'))!
    expect(within(row).getByTestId('pb-failed').textContent).toBe('Upload failed — remove it')
    await sleep(700)
    expect(puts).toBe(1) // not retried
    fireEvent.click(screen.getByRole('button', { name: 'Remove Broken mix' }))
    await waitFor(() => expect(status()).toContain('All changes saved ✓'), { timeout: 4000 })
    expect(puts).toBe(2)
    expect(v.tracks.map((t) => t.mediaId)).toEqual([501, 601])
  })
})
