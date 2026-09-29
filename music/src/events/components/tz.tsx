'use client'

// The site-wide time-zone choice ("ET | Local") and the ONE component that
// renders a time: <When>. The server always renders Eastern; after hydration
// the client switches to the viewer's saved choice (localStorage, mirrored to
// the efm_tz cookie so a later server feature can read it too).

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { formatIn, formatRange, type TzMode, type WhenFormat, zoneLabel, zoneOf } from './time'

const KEY = 'efm_tz'

type Ctx = { mode: TzMode; setMode: (m: TzMode) => void; zone: string | undefined }
const TzContext = createContext<Ctx>({ mode: 'et', setMode: () => {}, zone: zoneOf('et') })

export function readSavedTz(): TzMode | null {
  try {
    const v = window.localStorage.getItem(KEY)
    if (v === 'et' || v === 'local') return v
  } catch {
    // storage blocked
  }
  const m = /(?:^|;\s*)efm_tz=(et|local)\b/.exec(typeof document === 'undefined' ? '' : document.cookie)
  return (m?.[1] as TzMode | undefined) ?? null
}

export function TzProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<TzMode>('et')
  useEffect(() => {
    const saved = readSavedTz()
    if (saved && saved !== 'et') setModeState(saved)
  }, [])
  const setMode = useCallback((m: TzMode) => {
    setModeState(m)
    try {
      window.localStorage.setItem(KEY, m)
    } catch {
      // storage blocked: the cookie still carries it
    }
    document.cookie = `${KEY}=${m}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
  }, [])
  const value = useMemo(() => ({ mode, setMode, zone: zoneOf(mode) }), [mode, setMode])
  return <TzContext.Provider value={value}>{children}</TzContext.Provider>
}

export const useTz = () => useContext(TzContext)

/** The header's "ET | Local" switch: two real buttons, the chosen one pressed. */
export function TzToggle() {
  const { mode, setMode } = useTz()
  return (
    <div className="ev-tz" role="group" aria-label="Show times in">
      {(['et', 'local'] as const).map((m) => (
        <button key={m} type="button" className="ev-tz-btn" aria-pressed={mode === m} onClick={() => setMode(m)}>
          {m === 'et' ? 'ET' : 'Local'}
        </button>
      ))}
    </div>
  )
}

/**
 * Every time on the site. `at` alone renders one instant; `at` + `end` a
 * range. The zone label is always shown ("ET", or the local abbreviation).
 */
export function When({ at, end, format = 'datetime', className }: { at: string | Date; end?: string | Date; format?: WhenFormat; className?: string }) {
  const { mode } = useTz()
  const iso = new Date(at).toISOString()
  const text = end ? formatRange(at, end, mode) : formatIn(at, mode, format)
  const label = format === 'date' || format === 'weekday-date' ? null : zoneLabel(at, mode)
  return (
    <time dateTime={iso} className={className} data-tz={mode}>
      {text}
      {label ? <span className="ev-zone"> {label}</span> : null}
    </time>
  )
}
