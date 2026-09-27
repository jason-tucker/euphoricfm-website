'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, messageFor } from './api'
import { ConfirmDialog } from './ConfirmDialog'
import { Notice } from './ui'

export function WithdrawButton({ itemId, name }: { itemId: number; name: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/items/${itemId}/withdraw`, { method: 'POST' })
      setOpen(false)
      router.refresh()
    } catch (e) {
      setOpen(false)
      setError(messageFor(e, 'withdraw'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Withdraw
      </button>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ConfirmDialog open={open} title="Withdraw this song?" confirmLabel="Withdraw" confirmClass="btn-danger" busy={busy} onConfirm={() => void go()} onCancel={() => setOpen(false)}>
        <p>
          “{name}” will be taken out of review. This can’t be undone; you can submit it again later in a new batch.
        </p>
      </ConfirmDialog>
    </div>
  )
}
