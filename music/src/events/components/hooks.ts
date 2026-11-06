'use client'

import { useEffect, useState } from 'react'
import { DEFAULT_CONFIG, type EvConfig } from './types'

let cached: EvConfig | null = null
let inflight: Promise<EvConfig> | null = null

async function loadConfig(): Promise<EvConfig> {
  if (cached) return cached
  inflight ??= fetch('/api/ev/config', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then(async (r) => {
      if (!r.ok) throw new Error(String(r.status))
      const c = { ...DEFAULT_CONFIG, ...((await r.json()) as Partial<EvConfig>) }
      cached = c
      return c
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Test hook: forget the cached config. */
export function resetConfigCache() {
  cached = null
  inflight = null
}

/** GET /api/ev/config once per page; the launch defaults until it answers. */
export function useEvConfig(): { config: EvConfig; loaded: boolean; error: boolean } {
  const [state, setState] = useState<{ config: EvConfig; loaded: boolean; error: boolean }>({ config: cached ?? DEFAULT_CONFIG, loaded: !!cached, error: false })
  useEffect(() => {
    if (cached) return
    let live = true
    loadConfig()
      .then((c) => live && setState({ config: c, loaded: true, error: false }))
      .catch(() => live && setState((s) => ({ ...s, loaded: true, error: true })))
    return () => {
      live = false
    }
  }, [])
  return state
}

/** A clock that ticks every `ms` (for "starts in", notice checks). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
