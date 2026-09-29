// v0.4.0 "Add from a SoundCloud link" in the submit UI, plus the pure pieces
// it shares with the server (link shape, labels, messages).
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ERROR_TEXT, PROBE_ERROR_TEXT } from '@/components/messages'
import { FileCard } from '@/components/submit/FileCard'
import { SubmitFlow } from '@/components/submit/SubmitFlow'
import type { Entry } from '@/components/submit/types'
import { transcodeLabel } from '@/lib/fit'
import { CANONICAL_URL_RE, FETCH_ERROR_CODES, licenseLabel, parseSoundCloudUrl, soundcloudLabel } from '@/lib/soundcloud'
import { stubFetch } from './fetch'

vi.mock('tus-js-client', () => ({ Upload: class {} }))

const MB = 1024 * 1024
const flow = (o: Partial<Parameters<typeof SubmitFlow>[0]> = {}) =>
  render(
    <SubmitFlow
      initialBatchId={null}
      initialItems={[]}
      rights={{ version: 'v', text: 't' }}
      maxMp3UploadBytes={100 * MB}
      maxWavUploadBytes={250 * MB}
      chunkBytes={8 * MB}
      maxItemsPerBatch={20}
      fetchesPerDay={20}
      {...o}
    />,
  )

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('SoundCloud link shape (shared by the page and the server)', () => {
  const ok = (u: string, url: string) => expect(parseSoundCloudUrl(u)).toEqual({ ok: true, kind: expect.any(String), url })
  const no = (u: unknown, code = 'sc_bad_url') => expect(parseSoundCloudUrl(u)).toEqual({ ok: false, code })

  it('accepts public track links on soundcloud.com / m.soundcloud.com and on.soundcloud.com shortlinks; rebuilds them', () => {
    ok('https://soundcloud.com/artist-name/track_name-2', 'https://soundcloud.com/artist-name/track_name-2')
    ok('https://SoundCloud.com/Artist/Track/', 'https://soundcloud.com/artist/track')
    ok('https://m.soundcloud.com/artist/track', 'https://soundcloud.com/artist/track')
    // m1: the www host and a share link's timestamp fragment (both dropped)
    ok('https://www.soundcloud.com/artist/track', 'https://soundcloud.com/artist/track')
    ok('https://WWW.SoundCloud.com/a/b/', 'https://soundcloud.com/a/b')
    ok('https://soundcloud.com/a/b#t=1:00', 'https://soundcloud.com/a/b')
    ok('https://soundcloud.com/a/b?si=abc&utm_source=clipboard#t=12', 'https://soundcloud.com/a/b')
    ok('https://on.soundcloud.com/AbC123xyz#', 'https://on.soundcloud.com/AbC123xyz')
    ok('  https://soundcloud.com/a/b?si=0123abc&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing \n', 'https://soundcloud.com/a/b')
    ok('https://on.soundcloud.com/AbC123xyz', 'https://on.soundcloud.com/AbC123xyz')
  })

  it('refuses sets, playlists, likes, profiles and site pages as "not a track"', () => {
    for (const u of [
      'https://soundcloud.com/artist/sets/album',
      'https://soundcloud.com/artist',
      'https://soundcloud.com/artist/likes',
      'https://soundcloud.com/artist/reposts',
      'https://soundcloud.com/artist/tracks',
      'https://soundcloud.com/discover/sets',
      'https://soundcloud.com/search/sounds',
      'https://soundcloud.com/artist/track/s-SeCrEt',
      'https://soundcloud.com/you/likes',
    ])
      no(u, 'sc_not_a_track')
  })

  it('refuses every other host, scheme and trick', () => {
    for (const u of [
      'http://soundcloud.com/a/b',
      'https://www.soundcloud.com.evil.example/a/b',
      'https://www.on.soundcloud.com/AbC',
      'https://w.soundcloud.com/a/b',
      'https://api.soundcloud.com/tracks/1',
      'https://soundcloud.com.evil.example/a/b',
      'https://evil.example/soundcloud.com/a/b',
      'https://soundcloud.com@evil.example/a/b',
      'https://user@soundcloud.com/a/b',
      'https://soundcloud.com:443/a/b',
      'https://soundcloud.com/a/b#@evil.example/x',
      'https://soundcloud.com/a/b#' + 't'.repeat(65),
      'https://soundcloud.com/a/b#t=1#2',
      'https://soundcloud.com/a/b?url=https://evil.example',
      'https://soundcloud.com/a/b?si=1&si=2',
      'https://soundcloud.com/a%2Fb/c',
      'https://soundcloud.com/a/b\\c',
      'https://ѕoundcloud.com/a/b', // Cyrillic s
      'https://soundcloud．com/a/b', // fullwidth dot
      'https://on.soundcloud.com/a/b',
      'https://on.soundcloud.com/',
      'soundcloud.com/a/b',
      'javascript:alert(1)//soundcloud.com/a/b',
      'https://soundcloud.com/a/' + 'b'.repeat(101),
      '',
    ])
      no(u)
    no(42)
    no(null)
  })

  it('the canonical URL music-fetch reports is the only link reviewers are shown', () => {
    expect(CANONICAL_URL_RE.test('https://soundcloud.com/a-b/c_d')).toBe(true)
    for (const u of ['https://soundcloud.com/a/b/c', 'https://soundcloud.com/a', 'http://soundcloud.com/a/b', 'https://soundcloud.com/a/b?x=1', 'https://soundcloud.com/A/b', 'javascript:x'])
      expect(CANONICAL_URL_RE.test(u)).toBe(false)
  })

  it('labels', () => {
    expect(soundcloudLabel('cc-by')).toBe('From SoundCloud (CC BY)')
    expect(soundcloudLabel('all-rights-reserved')).toBe('From SoundCloud (All rights reserved)')
    expect(soundcloudLabel('some-new-id')).toBe('From SoundCloud (some-new-id)')
    expect(soundcloudLabel(null)).toBe('From SoundCloud (license not stated)')
    expect(licenseLabel('<script>')).toBeNull()
    expect(transcodeLabel('aac', 320)).toBe('Converted from AAC (320 kbps MP3)')
    expect(transcodeLabel('opus', 256)).toBe('Converted from Opus (256 kbps MP3)')
    expect(transcodeLabel('mp3', null)).toBeNull()
  })

  it('every music-fetch error code, every web refusal and every probe_fetch / worker rejection has a human message', () => {
    for (const c of FETCH_ERROR_CODES) expect(PROBE_ERROR_TEXT[`sc_${c}`], c).toBeTruthy()
    for (const c of ['sc_bad_url', 'sc_not_a_track', 'sc_disabled', 'sc_daily_cap', 'sc_busy', 'sc_rate_limited']) expect(ERROR_TEXT[c], c).toBeTruthy()
    const src = ['src/probe/fetched.ts', 'src/worker/soundcloud.ts'].map((p) => readFileSync(p, 'utf8')).join('\n')
    const codes = new Set([...src.matchAll(/(?:ProbeReject\(|rejectFetchItem\(ctx, it, |code: )'([a-z0-9_]+)'/g)].map((m) => m[1]!))
    expect(codes.size).toBeGreaterThan(10)
    const coverOnly = new Set(['cover_hash_mismatch', 'cover_type', 'cover_header', 'cover_decode']) // flags, never a rejection
    expect([...codes].filter((c) => !PROBE_ERROR_TEXT[c] && !coverOnly.has(c))).toEqual([])
  })

  it('v0.4.1: the portal accepts exactly the codes music-fetch can write (fetch/fetchsvc/errors.py), preview_only included', () => {
    const py = readFileSync('fetch/fetchsvc/errors.py', 'utf8')
    const pyCodes = [...py.matchAll(/^[A-Z_]+ = '([a-z_]+)'/gm)].map((m) => m[1]!)
    expect(pyCodes).toContain('preview_only')
    expect([...pyCodes].sort()).toEqual([...FETCH_ERROR_CODES].sort())
    expect(PROBE_ERROR_TEXT.sc_preview_only).toMatch(/^SoundCloud only offers a preview of this track/)
    expect(PROBE_ERROR_TEXT.sc_duration_mismatch).toMatch(/preview/)
  })
})

describe('the submit page’s SoundCloud box', () => {
  it('is a labelled input with an obvious button; a bad or playlist link is explained without calling the server', async () => {
    const calls = stubFetch({})
    flow()
    const input = screen.getByLabelText('Add from a SoundCloud link') as HTMLInputElement
    expect(input.disabled).toBe(false)
    const button = screen.getByRole('button', { name: /Add from SoundCloud/ })
    expect(button.className).toMatch(/\bbtn\b.*\bbtn-primary\b/)
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(/Coming soon/)).toBeNull()

    fireEvent.change(input, { target: { value: 'https://example.com/song.mp3' } })
    fireEvent.click(button)
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_TEXT.sc_bad_url)
    fireEvent.change(input, { target: { value: 'https://soundcloud.com/artist/sets/album' } })
    fireEvent.submit(input.closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_TEXT.sc_not_a_track)
    expect(calls).toEqual([])
  })

  it('a good link: draft batch, POST the REBUILT link, a card that follows the fetch, then the editable pre-fill with the license', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let polls = 0
    const scItem = { id: 5, batchId: 11, status: 'probing', source: 'soundcloud', fetchStage: 'fetching', sourceUrl: 'https://soundcloud.com/artist/track' }
    const done = {
      ...scItem,
      status: 'pending',
      fetchStage: null,
      fetchLicense: 'cc-by',
      title: 'SC Title',
      artist: 'SC Artist',
      album: null,
      genre: 'House',
      durationS: 141,
      bitrate: 320000,
      inputFormat: 'aac',
      transcodeKbps: 320,
      hasCover: true,
    }
    const calls = stubFetch({
      'POST /api/batches/11/soundcloud': { status: 201, body: { id: 5, status: 'probing', source: 'soundcloud', url: 'https://soundcloud.com/artist/track' } },
      'POST /api/batches': { status: 201, body: { id: 11 } },
      // v0.4.1: one batch GET per tick (not one GET per item)
      'GET /api/batches/11': () => {
        polls++
        return { status: 200, body: { id: 11, status: 'draft', items: [polls === 1 ? scItem : done] } }
      },
    })
    flow()
    fireEvent.change(screen.getByLabelText('Add from a SoundCloud link'), { target: { value: ' https://m.soundcloud.com/Artist/Track?si=xyz ' } })
    fireEvent.click(screen.getByRole('button', { name: /Add from SoundCloud/ }))
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/batches/11/soundcloud')).toBe(true))
    expect(calls.find((c) => c.url === '/api/batches/11/soundcloud')!.body).toEqual({ url: 'https://soundcloud.com/artist/track' })
    expect((screen.getByLabelText('Add from a SoundCloud link') as HTMLInputElement).value).toBe('')
    expect((await screen.findByRole('status')).textContent).toMatch(/Waiting for its turn/)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy() // a waiting link can be cancelled
    await vi.advanceTimersByTimeAsync(5000)
    expect((await screen.findByRole('status')).textContent).toMatch(/Fetching the track from SoundCloud/)
    await vi.advanceTimersByTimeAsync(5000) // a change resets the backoff to 5 s
    expect(await screen.findByText('From SoundCloud (CC BY)')).toBeTruthy()
    expect(polls).toBe(2)
    expect(calls.filter((c) => c.url.startsWith('/api/items/'))).toEqual([])
    expect(screen.getByText('Converted from AAC (320 kbps MP3)')).toBeTruthy()
    expect((screen.getByLabelText('Title *') as HTMLInputElement).value).toBe('SC Title')
    expect((screen.getByLabelText('Genre') as HTMLInputElement).value).toBe('House')
    // v0.4.1: the heading is "Artist – Title" at once, as after a reload
    expect(document.querySelector('[data-entry="sc-5"] p.truncate')!.textContent).toBe('SC Artist – SC Title')
    const link = screen.getByRole('link', { name: /Open on SoundCloud/ }) as HTMLAnchorElement
    expect(link.href).toBe('https://soundcloud.com/artist/track')
    expect(link.rel).toBe('noopener noreferrer nofollow')
  }, 20_000)

  it('a server refusal is shown in words', async () => {
    stubFetch({ 'POST /api/batches/11/soundcloud': { status: 429, body: { error: 'sc_daily_cap' } }, 'POST /api/batches': { status: 201, body: { id: 11 } } })
    flow()
    fireEvent.change(screen.getByLabelText('Add from a SoundCloud link'), { target: { value: 'https://soundcloud.com/a/b' } })
    fireEvent.click(screen.getByRole('button', { name: /Add from SoundCloud/ }))
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_TEXT.sc_daily_cap)
  })

  it('the card: stages while probing, the rejection message', () => {
    stubFetch({})
    const noop = () => {}
    const card = (e: Partial<Entry>) =>
      render(
        <FileCard
          entry={{ key: 'k', source: 'soundcloud', fileName: 'https://soundcloud.com/a/b', size: 0, phase: 'probing', progress: 1, itemId: 7, edits: { title: '', artist: '', album: '', genre: '' }, ...e } as Entry}
          inBatchDuplicate={false}
          onEdit={noop}
          onRemove={noop}
          onPause={noop}
          onResume={noop}
          onRetry={noop}
          onNewArtist={noop}
          onDuplicate={noop}
          onArt={noop}
        />,
      )
    card({})
    expect(screen.getByRole('status').textContent).toMatch(/Waiting for its turn/)
    document.body.innerHTML = ''
    card({ item: { id: 7, source: 'soundcloud', fetchStage: 'fetching' } as never })
    expect(screen.getByRole('status').textContent).toMatch(/Fetching the track from SoundCloud/)
    document.body.innerHTML = ''
    card({ item: { id: 7, source: 'soundcloud', fetchStage: 'converting' } as never })
    expect(screen.getByRole('status').textContent).toMatch(/Converting it to an MP3/)
    document.body.innerHTML = ''
    card({ phase: 'rejected', item: { id: 7, source: 'soundcloud', status: 'rejected', probeError: 'sc_extractor_failed' } as never })
    expect(screen.getByText(/may be private, removed/)).toBeTruthy()
    expect(screen.getByText(/This song will not be submitted/)).toBeTruthy()
    // v0.4.1: artwork that could not be used (music-fetch's artwork_host
    // warning and the rest) drops the cover, never the song: the ready card
    // says so next to the upload button.
    document.body.innerHTML = ''
    stubFetch({ 'GET /api/items/7/preview': { status: 200, body: { audioUrl: '/a', coverUrl: null } } })
    card({ phase: 'ready', item: { id: 7, source: 'soundcloud', status: 'pending', hasCover: false, fetchLicense: 'cc-by' } as never, edits: { title: 'T', artist: 'A', album: '', genre: '' } })
    expect(screen.getByText('No album art')).toBeTruthy()
    expect(screen.getByText(/SoundCloud's artwork for this track couldn't be used/)).toBeTruthy()
  })
})

describe('v0.4.1: the submit page and the kill switch, cancelling a link, reloads, polling', () => {
  const sc = (o: Record<string, unknown>) =>
    ({ id: 1, batchId: 11, kind: 'song', status: 'probing', source: 'soundcloud', fetchStage: 'queued', sourceUrl: 'https://soundcloud.com/a/b', title: null, artist: null, album: null, genre: null, ...o }) as never

  it('switch off: one muted line, no input, no button, no request', () => {
    const calls = stubFetch({})
    flow({ soundcloudEnabled: false })
    expect(screen.getByTestId('sc-off').textContent).toBe('Adding songs from a SoundCloud link is switched off right now. Upload the MP3 or WAV instead.')
    expect(screen.queryByLabelText('Add from a SoundCloud link')).toBeNull()
    expect(screen.queryByRole('button', { name: /Add from SoundCloud/ })).toBeNull()
    expect(screen.queryByTestId('sc-form')).toBeNull()
    expect(calls).toEqual([])
  })

  it('switch on: the help text states the limits (one at a time, 3 of yours at once, the daily cap)', () => {
    stubFetch({})
    flow({ fetchesPerDay: 7 })
    expect(screen.getByTestId('sc-form')).toBeTruthy()
    expect(document.getElementById('sc-help')!.textContent).toContain('Links are fetched one at a time, up to 3 of yours at once and 7 a day (a link that fails still counts).')
  })

  it('a reloaded draft: a waiting link (named by its link, cancellable) and a rejected one (with its reason)', async () => {
    const calls = stubFetch({})
    // plus one uploaded song that is ready, so "Review and submit" is enabled
    const ready = sc({ id: 3, status: 'pending', source: 'upload', fetchStage: null, sourceUrl: null, title: 'T', artist: 'A' })
    flow({ initialBatchId: 11, initialItems: [sc({ id: 1 }), sc({ id: 2, status: 'rejected', probeError: 'sc_extractor_failed', sourceUrl: 'https://soundcloud.com/a/c' }), ready] })
    const waiting = document.querySelector('[data-entry="item-1"]') as HTMLElement
    expect(waiting.dataset.phase).toBe('probing')
    expect(within(waiting).getByText('https://soundcloud.com/a/b')).toBeTruthy()
    expect(within(waiting).getByRole('status').textContent).toMatch(/Waiting for its turn .*you can cancel it/)
    expect((within(waiting).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false)
    const rejected = document.querySelector('[data-entry="item-2"]') as HTMLElement
    expect(rejected.dataset.phase).toBe('rejected')
    expect(within(rejected).getByText(/may be private, removed/)).toBeTruthy()
    // the blocker names links, and tells the member they can cancel
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /review and submit/i }))
    expect(screen.getByText('Wait until every song has finished uploading, fetching and checking, or cancel the SoundCloud links you don’t want to wait for.')).toBeTruthy()
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('Cancel on a waiting link withdraws it (POST /api/items/:id/withdraw) and removes the card', async () => {
    const calls = stubFetch({ 'POST /api/items/1/withdraw': { status: 200, body: { id: 1, status: 'withdrawn' } } })
    flow({ initialBatchId: 11, initialItems: [sc({ id: 1, fetchStage: 'fetching' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await vi.waitFor(() => expect(document.querySelector('[data-entry="item-1"]')).toBeNull())
    expect(calls).toEqual([{ method: 'POST', url: '/api/items/1/withdraw', body: undefined }])
  })

  it('polling: ONE batch request per tick for any number of probing items, 5 → 15 → 30 s, none while the tab is hidden', async () => {
    vi.useFakeTimers()
    let hidden = false
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    try {
      const items = [sc({ id: 1 }), sc({ id: 2 }), sc({ id: 3, source: 'upload', fetchStage: null, sourceUrl: null })]
      const calls = stubFetch({ 'GET /api/batches/11': { status: 200, body: { id: 11, items } } })
      flow({ initialBatchId: 11, initialItems: items })
      const gets = () => calls.filter((c) => c.method === 'GET').length
      expect(calls.filter((c) => c.url.startsWith('/api/items/'))).toEqual([])
      await vi.advanceTimersByTimeAsync(4_900)
      expect(gets()).toBe(0)
      await vi.advanceTimersByTimeAsync(200)
      expect(gets()).toBe(1) // 5 s, one request for all three
      await vi.advanceTimersByTimeAsync(15_000)
      expect(gets()).toBe(2) // then 15 s
      await vi.advanceTimersByTimeAsync(29_000)
      expect(gets()).toBe(2)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(gets()).toBe(3) // then every 30 s
      await vi.advanceTimersByTimeAsync(30_000)
      expect(gets()).toBe(4)
      // hidden: nothing at all
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(gets()).toBe(4)
      // visible again: back to 5 s
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(gets()).toBe(5)
      expect(new Set(calls.map((c) => c.url))).toEqual(new Set(['/api/batches/11']))
    } finally {
      if (desc) Object.defineProperty(Document.prototype, 'hidden', desc)
      delete (document as unknown as Record<string, unknown>).hidden
    }
  })

  it('polling stops once nothing is probing', async () => {
    vi.useFakeTimers()
    let n = 0
    const calls = stubFetch({
      'GET /api/batches/11': () => {
        n++
        return { status: 200, body: { id: 11, items: [sc({ id: 1, status: 'rejected', probeError: 'sc_too_long' })] } }
      },
    })
    flow({ initialBatchId: 11, initialItems: [sc({ id: 1 })] })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(n).toBe(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(n).toBe(1)
    expect((document.querySelector('[data-entry="item-1"]') as HTMLElement).dataset.phase).toBe('rejected')
    expect(calls).toHaveLength(1)
  })
})
