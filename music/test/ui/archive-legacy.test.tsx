// v0.3.3 UI: releasing an Unreleased song (artist confirmation, explicit
// playlists, the old membership only as a hint), linking a member to an
// archived song, and the admin "Archive the UNRELEASED folder" dry run →
// confirm flow.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LegacyImportPanel } from '@/components/admin/LegacyImportPanel'
import { ApiError, messageFor } from '@/components/api'
import { LinkMemberControl } from '@/components/requests/LinkMemberControl'
import { ReleaseButton } from '@/components/requests/ReleaseButton'
import { stubFetch } from './fetch'

const assignable = [
  { id: 2, label: '1General Rotation (#2)' },
  { id: 3, label: 'Night (#3)' },
]

describe('Release… (Unreleased songs)', () => {
  it('nothing is pre-selected, the old playlist is a hint; an existing artist releases with exactly the chosen playlists', async () => {
    const calls = stubFetch({
      'GET /api/ui/artist': { status: 200, body: { known: { id: 4, name: 'Jacob Gallagher', folder: 'Jacob Gallagher' }, proposedFolder: null, folderError: null, folderTaken: false } },
      'POST /api/archive/9/release': { status: 202, body: { queued: 'restore', archiveId: 9, folder: 'Jacob Gallagher' } },
    })
    render(<ReleaseButton archiveId={9} name="Jacob Gallagher — Save Me From Me" defaultArtist="Jacob Gallagher" assignable={assignable} hintLabels={['1General Rotation (#2)']} />)
    fireEvent.click(screen.getByRole('button', { name: 'Release…' }))
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([false, false])
    expect(screen.getByText(/Before it was archived it was in: 1General Rotation \(#2\) \(not selected for you\)/)).toBeTruthy()
    expect(screen.getByText(/not in rotation/)).toBeTruthy()
    await vi.waitFor(() => expect(screen.getByTestId('release-target').textContent).toBe('Goes to Music/Artists/Jacob Gallagher/'))
    fireEvent.click(screen.getByLabelText('Night (#3)'))
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ artist: 'Jacob Gallagher', playlistIds: [3] }))
    await vi.waitFor(() => expect(screen.getByText(/goes to Music\/Artists\/Jacob Gallagher\//)).toBeTruthy())
  })

  it('a new artist needs the explicit tick (and sends newArtist: true); a taken folder blocks the release', async () => {
    let taken = false
    const calls = stubFetch({
      'GET /api/ui/artist': () => ({ status: 200, body: { known: null, proposedFolder: 'Brand New', folderError: null, folderTaken: taken } }),
      'POST /api/archive/9/release': { status: 202, body: { queued: 'restore', archiveId: 9, folder: 'Brand New' } },
    })
    render(<ReleaseButton archiveId={9} name="x" defaultArtist="Brand New" assignable={assignable} hintLabels={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Release…' }))
    const tick = (await vi.waitFor(() => screen.getByLabelText(/Create this new artist \(folder Music\/Artists\/Brand New\/\)/))) as HTMLInputElement
    const release = screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement
    expect(release.disabled).toBe(true)
    fireEvent.click(tick)
    expect(release.disabled).toBe(false)
    fireEvent.click(release)
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ artist: 'Brand New', newArtist: true, playlistIds: [] }))
    await vi.waitFor(() => expect(screen.getByText(/goes to Music\/Artists\/Brand New\//)).toBeTruthy())
    taken = true
    fireEvent.click(screen.getByRole('button', { name: 'Release…' }))
    fireEvent.change(screen.getByLabelText('Artist folder'), { target: { value: 'AC/DC' } })
    await vi.waitFor(() => expect(screen.getByText(/already uses the folder/)).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('server refusals are readable', () => {
    for (const c of ['release_required', 'not_a_release', 'artist_unknown', 'artist_folder_taken', 'artist_pending', 'unknown_user', 'plan_stale', 'plan_not_ready', 'plan_already_run', 'import_in_progress', 'nothing_to_import']) {
      expect(messageFor(new ApiError(409, c)), c).not.toMatch(/request failed|Something went wrong/i)
    }
  })
})

describe('member links on an archived song', () => {
  it('searches signed-in users, links one (PUT) and unlinks (DELETE)', async () => {
    const calls = stubFetch({
      'GET /api/archive/link-candidates': { status: 200, body: { users: [{ id: 'u-1', name: 'Sophie', discordId: '123456789012345678' }] } },
      'PUT /api/archive/4/link': { status: 200, body: { archiveId: 4, linkedUser: { id: 'u-1', name: 'Sophie', discordId: '123456789012345678' } } },
      'DELETE /api/archive/4/link': { status: 200, body: { archiveId: 4, linkedUser: null } },
    })
    const { unmount } = render(<LinkMemberControl archiveId={4} linked={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Link a member…' }))
    fireEvent.change(screen.getByLabelText('Member name or Discord id'), { target: { value: 'soph' } })
    const btn = await vi.waitFor(() => screen.getByRole('button', { name: /Link Sophie/ }))
    expect(calls.some((c) => c.url === '/api/archive/link-candidates?q=soph')).toBe(true)
    fireEvent.click(btn)
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/api/archive/4/link', body: { userId: 'u-1' } }))
    unmount()
    render(<LinkMemberControl archiveId={4} linked={{ id: 'u-1', name: 'Sophie', discordId: '123456789012345678' }} />)
    expect(screen.getByText('Sophie')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/archive/4/link')).toBe(true))
  })
})

describe('Archive the UNRELEASED folder (admin page)', () => {
  it('dry run first (nothing moves), the planned moves are listed, then confirm sends that plan id', async () => {
    const plan = {
      root: 'Portal-Test/',
      folder: 'UNRELEASED-DO NOT ADD TO ROTATION/',
      playlistNames: { '2': '1General Rotation' },
      summary: { archive: 2, offAir: 1, refused: 1, skipped: 0, others: 0 },
      others: [],
      files: [
        { mediaId: 5112, path: 'UNRELEASED-DO NOT ADD TO ROTATION/save_me_from_me.mp3', dest: 'Removed/5112/save_me_from_me.mp3', artist: 'Jacob Gallagher', title: 'Save Me From Me', lengthS: 141, playlistIds: [2], foreignPlaylistIds: [], action: 'archive' },
        { mediaId: 631, path: 'UNRELEASED-DO NOT ADD TO ROTATION/kokoro_-_aodhi_-_never_finished.m4a', dest: 'Removed/631/kokoro_-_aodhi_-_never_finished.m4a', artist: 'Aodhi', title: 'Never Finished', lengthS: 197, playlistIds: [], foreignPlaylistIds: [], action: 'archive' },
        { mediaId: 700, path: 'UNRELEASED-DO NOT ADD TO ROTATION/ev.m4a', dest: 'Removed/700/ev.m4a', artist: 'X', title: 'Y', lengthS: 1, playlistIds: [], foreignPlaylistIds: [74], action: 'refuse_events' },
      ],
    }
    let state: unknown = { plan: null, jobsLive: 0, archiveCounts: {} }
    const calls = stubFetch({
      'GET /api/admin/legacy-import': () => ({ status: 200, body: state }),
      'POST /api/admin/legacy-import': (body) => {
        if ((body as { action: string }).action === 'dry_run') {
          state = { plan: { id: '11111111-1111-4111-8111-111111111111', status: 'ready', requestedAt: 'x', requestedBy: 'u', readyAt: 'x', plan }, jobsLive: 0, archiveCounts: {} }
          return { status: 202, body: { planId: '11111111-1111-4111-8111-111111111111', status: 'queued' } }
        }
        return { status: 202, body: { planId: '11111111-1111-4111-8111-111111111111', queued: 3 } }
      },
    })
    render(<LegacyImportPanel />)
    expect(screen.queryByRole('button', { name: /Confirm/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /dry run/ }))
    const confirm = await vi.waitFor(() => screen.getByRole('button', { name: 'Confirm: archive 3 files…' }))
    expect(screen.getByText(/Removed\/5112\/save_me_from_me.mp3/)).toBeTruthy()
    expect(screen.getByText('1General Rotation (#2)')).toBeTruthy()
    expect(screen.getByText('Refused: in an Events playlist (74)')).toBeTruthy()
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ action: 'dry_run' }])
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: 'Archive 3 files' }))
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ action: 'dry_run' }, { action: 'run', planId: '11111111-1111-4111-8111-111111111111' }]))
  })
})
