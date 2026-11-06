'use client'

// Native <dialog> confirmation (focus-trapped, Esc closes). No inline styles.

import { useEffect, useRef } from 'react'

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  confirmClass = 'btn-primary',
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  confirmLabel: string
  confirmClass?: string
  busy?: boolean
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal()
      else d.setAttribute('open', '')
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close()
      else d.removeAttribute('open')
    }
  }, [open])
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <h2 id="confirm-title" className="mb-3 text-lg font-bold text-sunburst">
        {title}
      </h2>
      <div className="space-y-3 text-sm">{children}</div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`btn ${confirmClass}`} onClick={onConfirm} disabled={busy || confirmDisabled}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
