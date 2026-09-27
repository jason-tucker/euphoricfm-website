'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { restoreSong } from '@/lib/api/requests'
import { messageFor } from '../api'
import { ConfirmDialog } from '../ConfirmDialog'
import { Notice } from '../ui'

export function RestoreButton({ archiveId, name }: { archiveId: number; name: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    try {
      await restoreSong(archiveId)
      setOpen(false)
      router.refresh()
    } catch (e) {
      setOpen(false)
      setError(messageFor(e, 'edit'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Restore
      </button>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ConfirmDialog open={open} title="Restore this song?" confirmLabel="Restore" busy={busy} onConfirm={() => void go()} onCancel={() => setOpen(false)}>
        <p>“{name}” goes back to its original folder and playlists.</p>
      </ConfirmDialog>
    </span>
  )
}
