// v0.4.0 "Add from a SoundCloud link" in the submit UI, plus the pure pieces
// it shares with the server (link shape, labels, messages).
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/react'
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
const flow = () =>
  render(<SubmitFlow initialBatchId={null} initialItems={[]} rights={{ version: 'v', text: 't' }} maxMp3UploadBytes={100 * MB} maxWavUploadBytes={250 * MB} chunkBytes={8 * MB} maxItemsPerBatch={20} />)

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
      'https://www.soundcloud.com/a/b',
      'https://api.soundcloud.com/tracks/1',
      'https://soundcloud.com.evil.example/a/b',
      'https://evil.example/soundcloud.com/a/b',
      'https://soundcloud.com@evil.example/a/b',
      'https://user@soundcloud.com/a/b',
      'https://soundcloud.com:443/a/b',
      'https://soundcloud.com/a/b#frag',
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
    let polls = 0
    const calls = stubFetch({
      'POST /api/batches/11/soundcloud': { status: 201, body: { id: 5, status: 'probing', source: 'soundcloud', url: 'https://soundcloud.com/artist/track' } },
      'POST /api/batches': { status: 201, body: { id: 11 } },
      'GET /api/items/5': () => {
        polls++
        if (polls === 1) return { status: 200, body: { id: 5, batchId: 11, status: 'probing', source: 'soundcloud', fetchStage: 'fetching', sourceUrl: 'https://soundcloud.com/artist/track' } }
        return {
          status: 200,
          body: {
            id: 5,
            batchId: 11,
            status: 'pending',
            source: 'soundcloud',
            fetchStage: null,
            fetchLicense: 'cc-by',
            sourceUrl: 'https://soundcloud.com/artist/track',
            title: 'SC Title',
            artist: 'SC Artist',
            album: null,
            genre: 'House',
            durationS: 141,
            bitrate: 320000,
            inputFormat: 'aac',
            transcodeKbps: 320,
            hasCover: true,
          },
        }
      },
    })
    flow()
    fireEvent.change(screen.getByLabelText('Add from a SoundCloud link'), { target: { value: ' https://m.soundcloud.com/Artist/Track?si=xyz ' } })
    fireEvent.click(screen.getByRole('button', { name: /Add from SoundCloud/ }))
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/batches/11/soundcloud')).toBe(true))
    expect(calls.find((c) => c.url === '/api/batches/11/soundcloud')!.body).toEqual({ url: 'https://soundcloud.com/artist/track' })
    expect((screen.getByLabelText('Add from a SoundCloud link') as HTMLInputElement).value).toBe('')
    expect((await screen.findByRole('status', {}, { timeout: 4000 })).textContent).toMatch(/SoundCloud/)
    expect(await screen.findByText('From SoundCloud (CC BY)', {}, { timeout: 8000 })).toBeTruthy()
    expect(screen.getByText('Converted from AAC (320 kbps MP3)')).toBeTruthy()
    expect((screen.getByLabelText('Title *') as HTMLInputElement).value).toBe('SC Title')
    expect((screen.getByLabelText('Genre') as HTMLInputElement).value).toBe('House')
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
  })
})
