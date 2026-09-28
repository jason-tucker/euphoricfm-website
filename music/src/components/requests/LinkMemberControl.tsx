'use client'

// v0.3.3: managers link one member (anyone who has signed in to the
// portal) to an archived song, so that member sees it under Archived
// songs; or unlink. Audited server-side.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { linkArchiveMember, unlinkArchiveMember } from '@/lib/api/requests'
import { messageFor } from '../api'
import { useDebounced, useJson } from '../hooks'
import { Notice } from '../ui'

type User = { id: string; name: string | null; discordId: string }

export function LinkMemberControl({ archiveId, linked }: { archiveId: number; linked: User | null }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dq = useDebounced(q.trim(), 250)
  const { data } = useJson<{ users: User[] }>(editing && dq.length >= 2 ? `/api/archive/link-candidates?q=${encodeURIComponent(dq.slice(0, 100))}` : null)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setEditing(false)
      setQ('')
      router.refresh()
    } catch (e) {
      setError(messageFor(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1 text-xs" data-testid={`link-${archiveId}`}>
      {linked ? (
        <p className="flex flex-wrap items-center gap-2 text-cream/70">
          <span>
            Visible to member: <span className="font-medium text-cream">{linked.name ?? linked.discordId}</span>
          </span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => unlinkArchiveMember(archiveId))}>
            Unlink
          </button>
        </p>
      ) : null}
      {editing ? (
        <div className="space-y-1">
          <label className="label" htmlFor={`link-q-${archiveId}`}>
            Member name or Discord id
          </label>
          <input id={`link-q-${archiveId}`} className="input" value={q} maxLength={100} autoComplete="off" onChange={(e) => setQ(e.target.value)} />
          <ul className="space-y-1">
            {(data?.users ?? []).map((u) => (
              <li key={u.id}>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => linkArchiveMember(archiveId, u.id))}>
                  Link {u.name ?? u.discordId} <span className="text-cream/50">({u.discordId})</span>
                </button>
              </li>
            ))}
          </ul>
          {dq.length >= 2 && data && data.users.length === 0 ? <p className="text-cream/55">No portal user matches (members appear here after they sign in once).</p> : null}
          <button type="button" className="link" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
          {linked ? 'Change member…' : 'Link a member…'}
        </button>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  )
}
