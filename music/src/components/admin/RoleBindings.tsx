'use client'

// Reviewer role bindings: list, add and remove (admin; audited server-side).

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { addRoleBinding, removeRoleBinding } from '@/lib/api/admin'
import { messageFor } from '../api'
import { ConfirmDialog } from '../ConfirmDialog'
import { when } from '../format'
import { Notice } from '../ui'

export type Binding = { id: number; roleId: string; permission: 'review' | 'manage'; note: string | null; createdBy: string | null; createdAt: string }

export function RoleBindings({ bindings }: { bindings: Binding[] }) {
  const router = useRouter()
  const [roleId, setRoleId] = useState('')
  const [perm, setPerm] = useState<'review' | 'manage'>('review')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<Binding | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const add = async () => {
    setMsg(null)
    if (!/^\d{17,20}$/.test(roleId.trim())) return setMsg({ tone: 'error', text: 'Enter a Discord role id (17–20 digits).' })
    setBusy(true)
    try {
      await addRoleBinding(roleId.trim(), perm, note.trim() || undefined)
      setRoleId('')
      setNote('')
      setMsg({ tone: 'ok', text: 'Role added. Members holding it get access within a minute.' })
      router.refresh()
    } catch (e) {
      setMsg({ tone: 'error', text: messageFor(e) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    try {
      await removeRoleBinding(removing.id)
      setMsg({ tone: 'ok', text: 'Role removed.' })
      router.refresh()
    } catch (e) {
      setMsg({ tone: 'error', text: messageFor(e) })
    } finally {
      setRemoving(null)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {bindings.length === 0 ? (
        <p className="text-sm text-cream/60">No role bindings.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-cream/50">
                <th className="py-1 pr-3">Discord role id</th>
                <th className="py-1 pr-3">Grants</th>
                <th className="py-1 pr-3">Note</th>
                <th className="py-1 pr-3">Added</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {bindings.map((b) => (
                <tr key={b.id} className="border-t border-cream/10" data-binding-id={b.id}>
                  <td className="py-2 pr-3 font-mono">{b.roleId}</td>
                  <td className="py-2 pr-3">
                    <span className={`chip ${b.permission === 'manage' ? 'chip-live' : 'chip-pending'}`}>{b.permission}</span>
                  </td>
                  <td className="py-2 pr-3 text-cream/70">{b.note ?? ''}</td>
                  <td className="py-2 pr-3 text-xs text-cream/55">
                    {when(b.createdAt)}
                    {b.createdBy ? ` by ${b.createdBy}` : ''}
                  </td>
                  <td className="py-2 text-right">
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => setRemoving(b)} disabled={busy}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="grid gap-3 rounded-xl border border-cream/10 p-3 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <div>
          <label className="label" htmlFor="rb-role">
            Discord role id
          </label>
          <input id="rb-role" className="input font-mono" inputMode="numeric" value={roleId} onChange={(e) => setRoleId(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="rb-perm">
            Grants
          </label>
          <select id="rb-perm" className="input" value={perm} onChange={(e) => setPerm(e.target.value as 'review' | 'manage')}>
            <option value="review">review</option>
            <option value="manage">manage (includes review)</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="rb-note">
            Note (optional)
          </label>
          <input id="rb-note" className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Add role
        </button>
      </form>

      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}

      <ConfirmDialog
        open={removing !== null}
        title="Remove this role?"
        confirmLabel="Remove"
        confirmClass="btn-danger"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      >
        <p>
          Members with role <code className="font-mono">{removing?.roleId}</code> lose {removing?.permission} access within a minute (unless another role grants it).
        </p>
      </ConfirmDialog>
    </div>
  )
}
