'use client'

// Approve or deny the new artist an approved edit request is waiting on.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { decideRequestArtist } from '@/lib/api/requests'
import { messageFor } from '../api'
import { ConfirmDialog } from '../ConfirmDialog'
import { Notice } from '../ui'

export function ArtistDecision({ artistId, name, folder }: { artistId: number; name: string; folder: string }) {
  const router = useRouter()
  const [mode, setMode] = useState<'idle' | 'approve' | 'deny'>('idle')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const go = async (d: { decision: 'approve' } | { decision: 'deny'; reason: string }) => {
    setBusy(true)
    setError(null)
    try {
      await decideRequestArtist(artistId, d)
      setDone(d.decision === 'approve' ? `Approved. “${name}” is now a library artist and the waiting edits continue.` : 'Denied. The waiting edits will fail with your reason.')
      router.refresh()
    } catch (e) {
      setError(messageFor(e, 'decision'))
    } finally {
      setBusy(false)
      setMode('idle')
    }
  }

  if (done) return <Notice tone="ok">{done}</Notice>
  return (
    <div className="space-y-2">
      {mode === 'deny' ? (
        <div className="space-y-2 rounded-xl border border-ruby/40 bg-ruby/[0.06] p-3">
          <label className="label" htmlFor={`ad-${artistId}`}>
            Reason for denying (required)
          </label>
          <textarea id={`ad-${artistId}`} className="input min-h-[60px]" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={() => (reason.trim() ? void go({ decision: 'deny', reason: reason.trim() }) : setError('A reason is required to deny.'))}
            >
              Confirm deny
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-approve btn-sm" onClick={() => setMode('approve')} disabled={busy}>
            Approve artist
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => setMode('deny')} disabled={busy}>
            Deny…
          </button>
        </div>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ConfirmDialog open={mode === 'approve'} title={`Approve “${name}”?`} confirmLabel="Approve" confirmClass="btn-approve" busy={busy} onConfirm={() => void go({ decision: 'approve' })} onCancel={() => setMode('idle')}>
        <p>
          Creates the folder <code className="break-all text-sunburst">Music/Artists/{folder}/</code> and lets the waiting edits move their files there.
        </p>
      </ConfirmDialog>
    </div>
  )
}
