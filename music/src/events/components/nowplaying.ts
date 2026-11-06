'use client'

// Event station now-playing, a React port of the info site's np-core poller:
// one request in flight, an 8 s timeout, paused while the tab is hidden and
// refreshed as soon as it is visible, slowed to 30 s after 3 misses in a row.

import { useEffect, useRef, useState } from 'react'

export type NpSong = { title?: string; artist?: string; text?: string; art?: string; album?: string }
export type NpEntry = { song?: NpSong; duration?: number; elapsed?: number; played_at?: number; playlist?: string }
export type NowPlaying = {
  station?: { name?: string }
  listeners?: { current?: number }
  now_playing?: NpEntry | null
  playing_next?: NpEntry | null
  song_history?: NpEntry[]
  is_online?: boolean
}

export const NP_POLL_MS = 15_000
export const NP_TIMEOUT_MS = 8_000
export const SLOW_RETRY_AFTER = 3
export const SLOW_RETRY_MS = 30_000

export function songLine(e: NpEntry | null | undefined): { title: string; artist: string } {
  const s = e?.song
  const title = (s?.title ?? '').trim()
  const artist = (s?.artist ?? '').trim()
  if (title || artist) return { title: title || (s?.text ?? '').trim(), artist }
  return { title: (s?.text ?? '').trim(), artist: '' }
}

export function useNowPlaying(url: string, pollMs = NP_POLL_MS): { data: NowPlaying | null; failures: number; loadedAt: number } {
  const [state, setState] = useState<{ data: NowPlaying | null; failures: number; loadedAt: number }>({ data: null, failures: 0, loadedAt: 0 })
  const inFlight = useRef(false)
  const failures = useRef(0)
  const lastAttempt = useRef(0)

  useEffect(() => {
    let live = true
    const poll = async () => {
      if (inFlight.current) return
      inFlight.current = true
      lastAttempt.current = Date.now()
      try {
        const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(NP_TIMEOUT_MS) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = (await r.json()) as NowPlaying
        failures.current = 0
        if (live) setState({ data: d, failures: 0, loadedAt: Date.now() })
      } catch {
        failures.current += 1
        if (live) setState((s) => ({ ...s, failures: failures.current }))
      } finally {
        inFlight.current = false
      }
    }
    const tick = () => {
      if (failures.current >= SLOW_RETRY_AFTER && Date.now() - lastAttempt.current < SLOW_RETRY_MS) return
      void poll()
    }
    let handle: ReturnType<typeof setInterval> | null = null
    const start = () => {
      handle ??= setInterval(tick, pollMs)
    }
    const stop = () => {
      if (handle) clearInterval(handle)
      handle = null
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void poll()
        start()
      } else stop()
    }
    document.addEventListener('visibilitychange', onVis)
    void poll()
    start()
    return () => {
      live = false
      stop()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [url, pollMs])

  return state
}
