'use client'

import { useEffect, useState } from 'react'

export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

// GET a read-only JSON endpoint whenever `url` changes (null = skip). Stale
// responses are dropped; errors surface as `error`.
export function useJson<T>(url: string | null): { data: T | null; error: boolean; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; error: boolean; loading: boolean }>({ data: null, error: false, loading: false })
  useEffect(() => {
    if (!url) {
      setState({ data: null, error: false, loading: false })
      return
    }
    let live = true
    setState((s) => ({ ...s, loading: true }))
    fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        return (await r.json()) as T
      })
      .then((d) => live && setState({ data: d, error: false, loading: false }))
      .catch(() => live && setState({ data: null, error: true, loading: false }))
    return () => {
      live = false
    }
  }, [url])
  return state
}
