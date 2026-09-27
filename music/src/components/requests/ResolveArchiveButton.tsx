'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { reconcileArchive } from '@/lib/api/requests'
import { messageFor } from '../api'
import { ConfirmDialog } from '../ConfirmDialog'
import { Notice } from '../ui'

// An archive or restore that stopped part way: the worker checks where the
// file really is and finishes or undoes the operation.
export function ResolveArchiveButton({ archiveId, name, status }: { archiveId: number; name: string; status: 'archiving' | 'restoring' }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    try {
      await reconcileArchive(archiveId)
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
        Resolve
      </button>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ConfirmDialog open={open} title="Resolve this song?" confirmLabel="Resolve" busy={busy} onConfirm={() => void go()} onCancel={() => setOpen(false)}>
        {status === 'archiving' ? (
          <p>“{name}” stopped part way through archiving. If the file already reached the archive, the archive is finished; otherwise the song stays in the library with its playlists.</p>
        ) : (
          <p>“{name}” stopped part way through restoring. If the file is already back in its folder, the restore is finished; otherwise it stays archived.</p>
        )}
      </ConfirmDialog>
    </span>
  )
}
