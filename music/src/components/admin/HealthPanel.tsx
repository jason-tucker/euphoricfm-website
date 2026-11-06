'use client'

import { useEffect, useState } from 'react'

type State = { ok: boolean | null; ms: number | null; at: string | null }

// Polls GET /api/health (DB round-trip) every 30 s.
export function HealthPanel() {
  const [s, setS] = useState<State>({ ok: null, ms: null, at: null })
  useEffect(() => {
    let live = true
    const check = async () => {
      const t0 = performance.now()
      let ok = false
      try {
        const r = await fetch('/api/health', { cache: 'no-store' })
        const j = (await r.json().catch(() => null)) as { ok?: boolean } | null
        ok = r.ok && j?.ok === true
      } catch {
        ok = false
      }
      if (live) setS({ ok, ms: Math.round(performance.now() - t0), at: new Date().toISOString().slice(11, 19) })
    }
    void check()
    const t = setInterval(() => void check(), 30_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])
  return (
    <div className="flex flex-wrap items-center gap-3" role="status" aria-live="polite">
      <span className={`chip ${s.ok === null ? 'chip-neutral' : s.ok ? 'chip-live' : 'chip-bad'}`}>
        {s.ok === null ? 'Checking…' : s.ok ? 'Web + database healthy' : 'Health check failing'}
      </span>
      {s.ms !== null ? <span className="text-xs text-cream/55">{s.ms} ms · checked {s.at} UTC · refreshes every 30 s</span> : null}
    </div>
  )
}
