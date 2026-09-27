'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { withdrawRequest } from '@/lib/api/requests'
import { messageFor } from '../api'
import { ConfirmDialog } from '../ConfirmDialog'
import { Notice } from '../ui'

export function RequestWithdrawButton({ id }: { id: number }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    try {
      await withdrawRequest(id)
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
    <span className="inline-flex flex-col gap-1">
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Withdraw
      </button>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ConfirmDialog open={open} title={`Withdraw request #${id}?`} confirmLabel="Withdraw" confirmClass="btn-danger" busy={busy} onConfirm={() => void go()} onCancel={() => setOpen(false)}>
        <p>The managers will stop reviewing it.</p>
      </ConfirmDialog>
    </span>
  )
}
