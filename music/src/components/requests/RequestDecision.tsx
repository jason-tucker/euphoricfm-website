'use client'

// Reviewer approve / deny for one edit or removal request. Deny requires a
// reason; 409 = another reviewer decided first.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { decideRequest } from '@/lib/api/requests'
import { messageFor } from '../api'
import { ConfirmDialog } from '../ConfirmDialog'
import { Notice } from '../ui'

export function RequestDecision({ id, kind, isSelf }: { id: number; kind: 'edit' | 'removal'; isSelf: boolean }) {
  const router = useRouter()
  const [mode, setMode] = useState<'idle' | 'approve' | 'deny'>('idle')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const approve = async () => {
    setBusy(true)
    setError(null)
    try {
      await decideRequest(id, { decision: 'approve' })
      setDone(kind === 'edit' ? 'Approved. The edit will be applied automatically.' : 'Approved. The song will be archived.')
      router.refresh()
    } catch (e) {
      setError(messageFor(e, 'decision'))
    } finally {
      setMode('idle')
      setBusy(false)
    }
  }

  const deny = async () => {
    if (!reason.trim()) return setError('A reason is required to deny. The requester sees it.')
    setBusy(true)
    setError(null)
    try {
      await decideRequest(id, { decision: 'deny', reason: reason.trim() })
      setDone('Denied. The requester will see your reason.')
      router.refresh()
    } catch (e) {
      setError(messageFor(e, 'decision'))
    } finally {
      setBusy(false)
    }
  }

  if (done) return <Notice tone="ok">{done}</Notice>

  return (
    <div className="space-y-2">
      {isSelf ? <Notice tone="warn">This is your own request. Approving it will be flagged as self-approved.</Notice> : null}
      {mode === 'deny' ? (
        <div className="space-y-2 rounded-xl border border-ruby/40 bg-ruby/[0.06] p-3">
          <label className="label" htmlFor={`rq-deny-${id}`}>
            Reason for denying (required, shown to the requester)
          </label>
          <textarea id={`rq-deny-${id}`} className="input min-h-[70px]" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void deny()} disabled={busy}>
              {busy ? 'Denying…' : 'Confirm deny'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('idle')} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-approve btn-sm" onClick={() => setMode('approve')} disabled={busy}>
            Approve
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => setMode('deny')} disabled={busy}>
            Deny…
          </button>
        </div>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ConfirmDialog
        open={mode === 'approve'}
        title={kind === 'edit' ? `Approve edit request #${id}?` : `Approve removal request #${id}?`}
        confirmLabel="Approve"
        confirmClass="btn-approve"
        busy={busy}
        onConfirm={() => void approve()}
        onCancel={() => setMode('idle')}
      >
        <p>{kind === 'edit' ? 'The changes are applied to the station automatically.' : 'The song is taken out of every playlist and archived. It can be restored later.'}</p>
      </ConfirmDialog>
    </div>
  )
}
