'use client'

// Admin settings editor. Saves each changed key with
// PUT /api/admin/settings {key, value} (server action owned by the
// foundation; see the UI report). Validates locally first.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { putSetting } from '@/lib/api/admin'
import { messageFor } from '../api'
import { Notice } from '../ui'

export type SettingsInput = {
  assignablePlaylistIds: number[]
  // Read-only: the worker's library sync owns it.
  stationPlaylistIds: number[]
  foreignPlaylistIds: number[]
  unconfirmedPlaylistIds?: number[]
  defaultPlaylistIds: number[]
  playlistNames: Record<string, string>
  autoCloseDays: number
  caps: { maxItemsPerBatch: number; ingestPerHour: number; ingestSpacingS: number } & Record<string, number>
  rights: { version: string; text: string }
  inviteUrl: string | null
}

const ids = (s: string) =>
  s
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)

function parseNames(s: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const line of s.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*=\s*(.{1,100})$/.exec(line)
    if (!m) return null
    out[m[1]!] = m[2]!.trim()
  }
  return out
}

export function SettingsForm({ initial }: { initial: SettingsInput }) {
  const router = useRouter()
  const [assignable, setAssignable] = useState(initial.assignablePlaylistIds.join(', '))
  const [defaults, setDefaults] = useState(initial.defaultPlaylistIds.join(', '))
  const [foreign, setForeign] = useState(initial.foreignPlaylistIds.join(', '))
  const [names, setNames] = useState(Object.entries(initial.playlistNames).map(([k, v]) => `${k} = ${v}`).join('\n'))
  const [autoClose, setAutoClose] = useState(String(initial.autoCloseDays))
  const [maxItems, setMaxItems] = useState(String(initial.caps.maxItemsPerBatch))
  const [perHour, setPerHour] = useState(String(initial.caps.ingestPerHour))
  const [spacing, setSpacing] = useState(String(initial.caps.ingestSpacingS))
  const [rightsText, setRightsText] = useState(initial.rights.text)
  const [invite, setInvite] = useState(initial.inviteUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const save = async () => {
    setMsg(null)
    const a = ids(assignable)
    const d = ids(defaults)
    const fo = ids(foreign)
    const nm = parseNames(names)
    const posInt = (v: string) => /^\d+$/.test(v.trim()) && Number(v) > 0
    if (a.some((n) => !Number.isInteger(n) || n <= 0) || a.length === 0) return setMsg({ tone: 'error', text: 'Assignable playlists must be a list of playlist ids, e.g. 2, 15.' })
    if (d.some((n) => !a.includes(n)) || d.length === 0) return setMsg({ tone: 'error', text: 'Default playlists must be chosen from the assignable playlists.' })
    if (fo.some((n) => !Number.isInteger(n) || n <= 0)) return setMsg({ tone: 'error', text: 'Events playlist ids must be a list of playlist ids.' })
    if (fo.some((n) => a.includes(n))) return setMsg({ tone: 'error', text: 'An Events playlist cannot also be assignable.' })
    if (!nm) return setMsg({ tone: 'error', text: 'Playlist names must be one per line, like: 2 = 1General Rotation' })
    if (![autoClose, maxItems, perHour, spacing].every(posInt)) return setMsg({ tone: 'error', text: 'Numbers must be whole numbers greater than zero.' })
    if (!rightsText.trim()) return setMsg({ tone: 'error', text: 'The rights statement cannot be empty.' })
    if (invite.trim() && !/^https:\/\/(discord\.gg|discord\.com)\//.test(invite.trim())) return setMsg({ tone: 'error', text: 'The invite link must start with https://discord.gg/ or https://discord.com/.' })

    const changes: { key: string; value: unknown }[] = []
    const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y)
    if (!same(a, initial.assignablePlaylistIds)) changes.push({ key: 'assignable_playlist_ids', value: a })
    if (!same(d, initial.defaultPlaylistIds)) changes.push({ key: 'default_playlist_ids', value: d })
    if (!same(fo, initial.foreignPlaylistIds)) changes.push({ key: 'foreign_playlist_ids', value: fo })
    if (!same(nm, initial.playlistNames)) changes.push({ key: 'playlist_names', value: nm })
    if (Number(autoClose) !== initial.autoCloseDays) changes.push({ key: 'auto_close_days', value: Number(autoClose) })
    const caps = { ...initial.caps, maxItemsPerBatch: Number(maxItems), ingestPerHour: Number(perHour), ingestSpacingS: Number(spacing) }
    if (!same(caps, initial.caps)) changes.push({ key: 'caps', value: caps })
    if (rightsText.trim() !== initial.rights.text) {
      // A new text is a new version: submissions record which one was attested.
      changes.push({ key: 'rights_attestation', value: { version: new Date().toISOString().slice(0, 10) + '.' + Date.now().toString(36), text: rightsText.trim() } })
    }
    if ((invite.trim() || null) !== initial.inviteUrl) changes.push({ key: 'discord_invite_url', value: invite.trim() || null })
    if (changes.length === 0) return setMsg({ tone: 'ok', text: 'Nothing changed.' })

    setBusy(true)
    const done: string[] = []
    try {
      for (const c of changes) {
        await putSetting(c.key, c.value)
        done.push(c.key)
      }
      setMsg({ tone: 'ok', text: `Saved: ${done.join(', ')}.` })
      router.refresh()
    } catch (e) {
      setMsg({ tone: 'error', text: `${done.length ? `Saved ${done.join(', ')}; then ` : ''}${messageFor(e)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Text id="assignable" label="Assignable playlist ids" value={assignable} onChange={setAssignable} help="Reviewers can only pick from these." />
        <Text id="defaults" label="Default playlist ids" value={defaults} onChange={setDefaults} help="Pre-selected on approval; must be assignable." />
        <div className="sm:col-span-2">
          <Text
            id="foreign"
            label="Events station playlist ids"
            value={foreign}
            onChange={setForeign}
            help="Playlists of the Events station (listings also include them). Songs in these are never archived, and playlist changes never touch them. An id the station already uses can only be added while it is unconfirmed."
          />
        </div>
        <div className="sm:col-span-2">
          <p className="label">All playlist ids of this station (kept up to date by the library sync)</p>
          <p className="font-mono text-sm" id="station">
            {initial.stationPlaylistIds.length ? initial.stationPlaylistIds.join(', ') : 'not synced yet'}
          </p>
          {initial.unconfirmedPlaylistIds?.length ? (
            <p className="mt-1 text-xs text-cream/50">Unconfirmed (new since the first sync; could be Events playlists): {initial.unconfirmedPlaylistIds.join(', ')}</p>
          ) : null}
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="names">
            Playlist names (one per line: id = name)
          </label>
          <textarea id="names" className="input min-h-[70px] font-mono" value={names} onChange={(e) => setNames(e.target.value)} />
        </div>
        <Text id="autoclose" label="Auto-close completed tickets after (days)" value={autoClose} onChange={setAutoClose} inputMode="numeric" />
        <Text id="maxitems" label="Max songs per batch" value={maxItems} onChange={setMaxItems} inputMode="numeric" />
        <Text id="perhour" label="Ingests per hour" value={perHour} onChange={setPerHour} inputMode="numeric" />
        <Text id="spacing" label="Seconds between ingests" value={spacing} onChange={setSpacing} inputMode="numeric" />
        <div className="sm:col-span-2">
          <label className="label" htmlFor="rights">
            Rights statement (current version {initial.rights.version}; editing creates a new version)
          </label>
          <textarea id="rights" className="input min-h-[90px]" maxLength={2000} value={rightsText} onChange={(e) => setRightsText(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <Text id="invite" label="Discord invite link (shown to non-members)" value={invite} onChange={setInvite} help="https://discord.gg/…" />
        </div>
      </div>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  )
}

function Text({
  id,
  label,
  value,
  onChange,
  help,
  inputMode,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  help?: string
  inputMode?: 'numeric'
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" value={value} inputMode={inputMode} onChange={(e) => onChange(e.target.value)} />
      {help ? <p className="mt-1 text-xs text-cream/50">{help}</p> : null}
    </div>
  )
}
