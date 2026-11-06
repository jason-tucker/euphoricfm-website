import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Player } from '@/events/components/Player'

// The Event Radio player: a now-playing request that fails (network, CORS)
// shows a neutral "Now playing unavailable", never OFF AIR; OFF AIR is only
// for a station that reports is_online === false.

const NP = 'https://np.test/api/nowplaying/event'

function stubNp(reply: () => Promise<unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = await reply()
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

const renderPlayer = () => render(<Player streamUrl="https://np.test/radio.mp3" nowPlayingUrl={NP} />)

describe('event radio player', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a failed now-playing request is neutral: no OFF AIR', async () => {
    stubNp(() => Promise.reject(new TypeError('Failed to fetch')))
    renderPlayer()
    await waitFor(() => expect(screen.getByTestId('np-title').textContent).toBe('Now playing unavailable'))
    expect(screen.queryByText('OFF AIR')).toBeNull()
    expect(screen.queryByText('ON AIR')).toBeNull()
    expect(screen.getByRole('button', { name: 'Play Event Radio' })).toBeTruthy()
  })

  it('shows OFF AIR when the station reports is_online === false', async () => {
    stubNp(async () => ({ is_online: false, now_playing: null }))
    renderPlayer()
    expect(await screen.findByText('OFF AIR')).toBeTruthy()
    expect(screen.getByTestId('np-title').textContent).not.toBe('Now playing unavailable')
  })

  it('shows ON AIR and the song when the station is online', async () => {
    stubNp(async () => ({ is_online: true, now_playing: { song: { title: 'Midnight Drive', artist: 'Nova' }, duration: 200, elapsed: 10 } }))
    renderPlayer()
    await waitFor(() => expect(screen.getByTestId('np-title').textContent).toBe('Midnight Drive'))
    expect(screen.getByText('ON AIR')).toBeTruthy()
  })
})
