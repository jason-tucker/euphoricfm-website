'use client'

// v0.4.1: a date in the viewer's own time zone. The server (and the first
// client render) print the deterministic UTC text, then the browser swaps in
// the local one, so hydration never mismatches.
import { useEffect, useState } from 'react'
import { localWhen, when } from './format'

export function LocalTime({ iso }: { iso: string | null | undefined }) {
  const [text, setText] = useState(() => when(iso))
  useEffect(() => setText(localWhen(iso)), [iso])
  if (!iso) return null
  return (
    <time dateTime={iso} title={when(iso)} suppressHydrationWarning>
      {text}
    </time>
  )
}
