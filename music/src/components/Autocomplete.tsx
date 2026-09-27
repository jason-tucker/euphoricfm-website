'use client'

// Text input with library suggestions from GET /api/ui/library (a native
// <datalist>, so it works with touch keyboards and screen readers).

import { useId } from 'react'
import { useDebounced, useJson } from './hooks'

type Hit = { value: string; hint?: string }

export function Autocomplete({
  field,
  value,
  onChange,
  label,
  placeholder,
  disabled,
  name,
}: {
  field: 'artist' | 'album'
  value: string
  onChange: (v: string) => void
  label: string
  placeholder?: string
  disabled?: boolean
  name?: string
}) {
  const id = useId()
  const q = useDebounced(value.trim(), 250)
  const { data } = useJson<{ results: Hit[] }>(q.length >= 2 && !disabled ? `/api/ui/library?field=${field}&q=${encodeURIComponent(q.slice(0, 100))}` : null)
  return (
    <div>
      <label className="label" htmlFor={`${id}-in`}>
        {label}
      </label>
      <input
        id={`${id}-in`}
        name={name}
        className="input"
        list={`${id}-list`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={200}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={`${id}-list`}>
        {(data?.results ?? []).map((h) => (
          <option key={`${h.value}|${h.hint ?? ''}`} value={h.value}>
            {h.hint}
          </option>
        ))}
      </datalist>
    </div>
  )
}
