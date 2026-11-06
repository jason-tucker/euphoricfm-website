// v0.4.1 (A5, A8): member-facing copy and small UI fixes: the archived page
// per role, SoundCloud stage labels on My music / the batch page, names and
// dates without internal identifiers, the MP3 fit hint, the upload message,
// thumbnails that renew an expired signed URL, and the song page's Folder row.
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localWhen, playlistLabel, playlistName, songName, when } from '@/components/format'
import { LocalTime } from '@/components/LocalTime'
import { ERROR_TEXT } from '@/components/messages'
import { FileCard } from '@/components/submit/FileCard'
import { id3TagBytes, type Entry } from '@/components/submit/types'
import { signedCoverItem, Thumb } from '@/components/Thumb'
import { ItemStatusChip } from '@/components/ui'
import { AUDIO_PAYLOAD_BYTES, MAX_UPLOAD_BYTES } from '@/lib/fit'
import { stubFetch } from './fetch'

type V = { userId: string; discordId: string; name: string; perms: Set<string> }
const state = vi.hoisted(() => ({ viewer: null as null | V }))
const row = (staff: boolean) => ({
  id: 4,
  label: 'Removed' as const,
  title: 'Night',
  artist: 'GRIM',
  fileName: 'x.mp3',
  archivedAt: '2026-09-28T14:03:00.000Z',
  reason: null,
  ...(staff
    ? { staff: { status: 'archived', origin: 'portal', mediaId: 501, folder: 'GRIM', originalPath: 'Music/Artists/GRIM/x.mp3', requestId: 7, playlistIds: [2], linkedUser: null, uploader: null, releaseArtistId: null } }
    : {}),
})

vi.mock('@/server/db/client', () => ({ getDb: () => ({}) }))
vi.mock('@/server/ui/page', () => ({ pageViewer: async () => state.viewer!, orNotFound: async <T,>(fn: () => Promise<T>) => fn(), headerViewer: async () => state.viewer }))
vi.mock('@/server/ui/browse', () => ({
  archivedSongs: async (_db: unknown, v: V) => ({ rows: [row(v.perms.has('review'))], total: 1, page: 1, pages: 1 }),
  librarySong: async () => ({
    song: { mediaId: 501, title: 'Night Song', fileName: 'x.mp3', artist: 'GRIM', album: 'Night', genre: 'House', lengthS: 200, folder: 'GRIM', artUrl: null, playlistIds: null },
    myRequests: [{ id: 7, kind: 'edit', status: 'pending', createdAt: '2026-09-28T14:03:00.000Z' }],
    openRequests: 1,
  }),
}))
vi.mock('@/server/ui/settings', async () => {
  const { DEFAULT_CAPS } = await import('@/server/settings-defaults')
  return { uiSettings: async () => ({ assignablePlaylistIds: [2], playlistNames: { '2': 'General Rotation' }, caps: DEFAULT_CAPS }) }
})
vi.mock('@/server/http/route', () => ({ parseId: (s: string) => Number(s) }))

const member: V = { userId: 'u1', discordId: '100000000000000001', name: 'Mia', perms: new Set(['submit', 'request']) }
const reviewer: V = { ...member, userId: 'u2', perms: new Set(['submit', 'request', 'review']) }
const manager: V = { ...member, userId: 'u3', perms: new Set(['submit', 'request', 'review', 'manage']) }

beforeEach(() => {
  state.viewer = member
})

describe('Archived songs page, per role', async () => {
  const { default: Archived } = await import('@/app/library/archived/page')
  const page = async () => render(await Archived({ searchParams: Promise.resolve({}) }))

  it('member: their own songs, where to ask (the removal ticket), no controls, no internal ids', async () => {
    await page()
    const sub = document.querySelector('main, section')!.textContent!
    expect(sub).toContain('say so in its removal ticket in Discord (or in your batch ticket) and a manager can restore it')
    expect(sub).not.toContain('Ask a manager if')
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
    expect(document.body.textContent).not.toContain('media #')
  })

  it('reviewer (no manage): all songs, told that managers restore; no Restore / Release / link controls', async () => {
    state.viewer = reviewer
    await page()
    expect(document.body.textContent).toContain('Managers can restore a removed song or release an unreleased one.')
    expect(document.body.textContent).not.toContain('Restoring a removed song puts it back')
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Link/ })).toBeNull()
  })

  it('manager: the how-to sentence and the controls', async () => {
    state.viewer = manager
    stubFetch({})
    await page()
    expect(document.body.textContent).toContain('Restoring a removed song puts it back in its folder and playlists')
    expect(screen.getByRole('button', { name: /Restore/ })).toBeTruthy()
  })
})

describe('Song page: the Folder row is staff-only; request dates are local', async () => {
  const { default: Song } = await import('@/app/library/[mediaId]/page')
  const page = async () => render(await Song({ params: Promise.resolve({ mediaId: '501' }), searchParams: Promise.resolve({}) }))

  it('member: no Folder row', async () => {
    stubFetch({})
    await page()
    expect(screen.queryByText('Folder')).toBeNull()
    expect(document.body.textContent).not.toContain('Music/Artists/GRIM')
    expect(document.body.textContent).toContain('Edit request #7')
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
  })

  it('reviewer: the Folder row', async () => {
    state.viewer = reviewer
    stubFetch({})
    await page()
    expect(screen.getByText('Folder')).toBeTruthy()
    expect(screen.getByText('Music/Artists/GRIM')).toBeTruthy()
  })
})

describe('SoundCloud links on My music and the batch page', () => {
  it('a probing link shows its stage, not "Checking file"; an upload still says "Checking file"', () => {
    const chip = (p: Parameters<typeof ItemStatusChip>[0]) => {
      document.body.innerHTML = ''
      render(<ItemStatusChip {...p} />)
      return document.body.textContent
    }
    expect(chip({ status: 'probing', source: 'soundcloud', fetchStage: 'queued' })).toBe('Waiting for SoundCloud')
    expect(chip({ status: 'probing', source: 'soundcloud', fetchStage: null })).toBe('Waiting for SoundCloud')
    expect(chip({ status: 'probing', source: 'soundcloud', fetchStage: 'fetching' })).toBe('Fetching from SoundCloud')
    expect(chip({ status: 'probing', source: 'soundcloud', fetchStage: 'converting' })).toBe('Converting')
    expect(chip({ status: 'probing', source: 'upload' })).toBe('Checking file')
    expect(chip({ status: 'pending', source: 'soundcloud' })).toBe('Pending review')
  })

  it('an untitled link is named by its link, not "Untitled"', () => {
    expect(songName({ title: null, artist: null, source: 'soundcloud', sourceUrl: 'https://soundcloud.com/a/b' })).toBe('soundcloud.com/a/b')
    expect(songName({ title: 'T', artist: 'A', source: 'soundcloud', sourceUrl: 'https://soundcloud.com/a/b' })).toBe('A – T')
    expect(songName({ title: null, artist: null })).toBe('Untitled')
  })
})

describe('no internal identifiers for members', () => {
  it('playlist names without the id (staff screens keep it)', () => {
    expect(playlistName({ '2': 'General Rotation' }, 2)).toBe('General Rotation')
    expect(playlistName({}, 31)).toBe('Playlist #31')
    expect(playlistLabel({ '2': 'General Rotation' }, 2)).toBe('General Rotation (#2)')
  })

  it('dates: UTC text first (no hydration mismatch), then the viewer’s local time', async () => {
    const iso = '2026-09-28T14:03:00.000Z'
    expect(when(iso)).toBe('2026-09-28 14:03 UTC')
    render(<LocalTime iso={iso} />)
    const t = document.querySelector('time')!
    expect(t.getAttribute('datetime')).toBe(iso)
    await vi.waitFor(() => expect(t.textContent).toBe(localWhen(iso)))
    expect(t.textContent).not.toContain('UTC')
    expect(t.getAttribute('title')).toBe('2026-09-28 14:03 UTC')
  })

  it('the concurrent-uploads message has no hard-coded number', () => {
    expect(ERROR_TEXT.too_many_concurrent_uploads).toBe('Only a few uploads can run at once. The rest start when these finish.')
    expect(ERROR_TEXT.too_many_concurrent_uploads).not.toMatch(/\d/)
  })
})

describe('"Converting it down so it fits" only when the probe will convert (the 34.6–35 MiB band)', () => {
  const card = (e: Partial<Entry>) => {
    document.body.innerHTML = ''
    const noop = () => {}
    render(
      <FileCard
        entry={{ key: 'k', fileName: 'big.mp3', size: 0, phase: 'probing', progress: 1, itemId: 7, edits: { title: '', artist: '', album: '', genre: '' }, ...e } as Entry}
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
    return screen.getByRole('status').textContent!
  }

  it('reads the ID3v2 tag size like the probe', () => {
    const head = (size: number, major = 3, flags = 0) => new Uint8Array([0x49, 0x44, 0x33, major, 0, flags, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
    expect(id3TagBytes(head(500_000))).toBe(500_010)
    expect(id3TagBytes(head(100, 4, 0x10))).toBe(120) // v2.4 footer
    expect(id3TagBytes(new Uint8Array([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0]))).toBe(0)
    expect(id3TagBytes(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0x80, 0, 0, 0]))).toBe(0) // not syncsafe
  })

  it('a 34.8 MB MP3 with a 500 KB cover tag is kept untouched: no "converting" hint; without the tag it is', () => {
    const size = AUDIO_PAYLOAD_BYTES + 200_000
    expect(size).toBeLessThanOrEqual(MAX_UPLOAD_BYTES)
    expect(card({ size, id3Size: 500_010 })).toBe('Checking the file and reading its tags…')
    expect(card({ size, id3Size: 0 })).toMatch(/converting it down so it fits/)
    expect(card({ size: MAX_UPLOAD_BYTES + 1, id3Size: 500_010 })).toMatch(/converting it down so it fits/)
  })
})

describe('thumbnails renew an expired signed cover URL once', () => {
  it('on error, GET /api/items/:id/preview for a fresh URL; a second failure shows the placeholder', async () => {
    expect(signedCoverItem('/api/media/cover/42?exp=1&sig=x')).toBe(42)
    expect(signedCoverItem('https://euphoric.fm/api/station/euphoricfm/art/x.jpg')).toBeNull()
    const calls = stubFetch({ 'GET /api/items/42/preview': { status: 200, body: { coverUrl: '/api/media/cover/42?exp=2&sig=y' } } })
    render(<Thumb src="/api/media/cover/42?exp=1&sig=x" alt="art" />)
    const img = screen.getByRole('img', { name: 'art' }) as HTMLImageElement
    expect(img.getAttribute('decoding')).toBe('async')
    expect(img.getAttribute('fetchpriority')).toBe('low')
    fireEvent.error(img)
    await vi.waitFor(() => expect((screen.getByRole('img', { name: 'art' }) as HTMLImageElement).getAttribute('src')).toBe('/api/media/cover/42?exp=2&sig=y'))
    expect(calls.map((c) => c.url)).toEqual(['/api/items/42/preview'])
    fireEvent.error(screen.getByRole('img', { name: 'art' }))
    expect(screen.getByRole('img', { name: 'No album art' })).toBeTruthy()
    expect(calls).toHaveLength(1)
  })

  it('library art (not a signed URL) goes straight to the placeholder', () => {
    const calls = stubFetch({})
    render(<Thumb src="https://euphoric.fm/api/station/euphoricfm/art/x.jpg" alt="art" />)
    fireEvent.error(screen.getByRole('img', { name: 'art' }))
    expect(screen.getByRole('img', { name: 'No album art' })).toBeTruthy()
    expect(calls).toEqual([])
  })
})
