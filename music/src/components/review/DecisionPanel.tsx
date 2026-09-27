'use client'

// Reviewer decision for one pending item:
//   song        metadata edits (saved before approval), playlist picker limited
//               to the assignable ids, approve / deny
//   new_artist  folder name with a live sanitizer preview (the real path
//               builder, via GET /api/ui/artist?folder=), approve / deny
// Deny REQUIRES a reason (checked here, and again by the server). Approving
// your own submission shows the self-approval warning first. A 409 means
// another reviewer decided first.

import { useState } from 'react'
import { api, messageFor } from '../api'
import { Autocomplete } from '../Autocomplete'
import { ConfirmDialog } from '../ConfirmDialog'
import { useDebounced, useJson } from '../hooks'
import { FOLDER_ERROR_TEXT } from '../messages'
import { NewArtistBadge, Notice } from '../ui'

export type Fields = { title: string; artist: string; album: string; genre: string }
const KEYS = ['title', 'artist', 'album', 'genre'] as const

type FolderPreview = { proposedFolder: string | null; folderError: string | null; folderTaken: boolean }

export function DecisionPanel({
  itemId,
  kind,
  isSelf,
  assignable,
  initialPlaylistIds,
  initialFields,
  initialFolder,
  onDecided,
}: {
  itemId: number
  kind: 'song' | 'new_artist'
  isSelf: boolean
  assignable: { id: number; label: string }[]
  initialPlaylistIds: number[]
  initialFields: Fields
  initialFolder?: string
  onDecided: (status: 'approved' | 'denied') => void
}) {
  const [fields, setFields] = useState<Fields>(initialFields)
  const [playlists, setPlaylists] = useState<number[]>(initialPlaylistIds.filter((id) => assignable.some((a) => a.id === id)))
  const [folder, setFolder] = useState(initialFolder ?? '')
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'idle' | 'approve' | 'deny'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const f = useDebounced(folder, 250)
  const preview = useJson<FolderPreview>(kind === 'new_artist' && f.trim() ? `/api/ui/artist?folder=${encodeURIComponent(f.slice(0, 300))}` : null)
  const previewFresh = f === folder && !preview.loading

  const changed: Partial<Record<keyof Fields, string | null>> = {}
  for (const k of KEYS) if (fields[k].trim() !== initialFields[k].trim()) changed[k] = fields[k].trim() || null

  const approveBlocker = (): string | null => {
    if (kind === 'song') {
      if (!fields.title.trim() || !fields.artist.trim()) return 'Title and artist are required.'
      if (playlists.length === 0) return 'Pick at least one playlist.'
    } else {
      if (!folder.trim()) return 'Enter a folder name.'
      if (!previewFresh) return 'Wait for the folder preview to update.'
      if (!preview.data?.proposedFolder) return 'This folder name cannot be used. Change it first.'
      if (preview.data.folderTaken) return 'A folder with this name already exists. Choose a different name.'
    }
    return null
  }

  const startApprove = () => {
    setError(null)
    const b = approveBlocker()
    if (b) return setError(b)
    setMode('approve')
  }

  const startDeny = () => {
    setError(null)
    setMode('deny')
  }

  const doApprove = async () => {
    setBusy(true)
    setError(null)
    try {
      if (kind === 'song' && Object.keys(changed).length) {
        await api(`/api/items/${itemId}`, { method: 'PATCH', json: changed })
      }
      const body = kind === 'song' ? { decision: 'approve', playlistIds: playlists } : { decision: 'approve', folder: preview.data?.proposedFolder }
      await api(`/api/items/${itemId}/decision`, { json: body })
      setMode('idle')
      onDecided('approved')
    } catch (e) {
      setMode('idle')
      setError(messageFor(e, 'decision'))
    } finally {
      setBusy(false)
    }
  }

  const doDeny = async () => {
    const r = reason.trim()
    if (!r) {
      setError('A reason is required to deny. The submitter sees it.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api(`/api/items/${itemId}/decision`, { json: { decision: 'deny', reason: r } })
      setMode('idle')
      onDecided('denied')
    } catch (e) {
      setError(messageFor(e, 'decision'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card space-y-5" aria-label="Decision">
      {kind === 'song' ? (
        <>
          <div>
            <h2 className="mb-2 font-semibold">Metadata</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Title *" value={fields.title} onChange={(v) => setFields({ ...fields, title: v })} />
              <Autocomplete field="artist" label="Artist *" value={fields.artist} onChange={(v) => setFields({ ...fields, artist: v })} />
              <Autocomplete field="album" label="Album" value={fields.album} onChange={(v) => setFields({ ...fields, album: v })} />
              <Field label="Genre" value={fields.genre} onChange={(v) => setFields({ ...fields, genre: v })} />
            </div>
            {Object.keys(changed).length ? <p className="mt-2 text-xs text-cream/60">Edited: {Object.keys(changed).join(', ')}. Saved when you approve.</p> : null}
          </div>
          <fieldset>
            <legend className="mb-2 font-semibold">Playlists</legend>
            {assignable.length === 0 ? <Notice tone="warn">No playlists are assignable. An admin must set them in Admin → Settings.</Notice> : null}
            <div className="flex flex-wrap gap-2">
              {assignable.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-xl border border-cream/20 bg-cream/[0.04] px-3 py-2 text-sm hover:border-sunburst/50">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={playlists.includes(p.id)}
                    onChange={(e) => setPlaylists(e.target.checked ? [...playlists, p.id] : playlists.filter((x) => x !== p.id))}
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : (
        <div className="space-y-2">
          <h2 className="flex items-center gap-2 font-semibold">
            <NewArtistBadge /> Approve the new artist folder
          </h2>
          <label className="label" htmlFor="folder">
            Folder name
          </label>
          <input id="folder" className="input" value={folder} maxLength={300} onChange={(e) => setFolder(e.target.value)} />
          <div className="rounded-xl border border-cream/10 bg-ink/50 p-3 text-sm" aria-live="polite">
            {!folder.trim() ? (
              <span className="text-cream/50">Type a folder name to preview it.</span>
            ) : preview.loading || !previewFresh ? (
              <span className="text-cream/50">Checking…</span>
            ) : preview.data?.proposedFolder ? (
              <>
                Will create <code className="break-all text-sunburst">Music/Artists/{preview.data.proposedFolder}/</code>
                {preview.data.proposedFolder !== folder.trim() ? <p className="mt-1 text-xs text-cream/60">Some characters were changed or removed to make a safe folder name.</p> : null}
                {preview.data.folderTaken ? <p className="mt-1 text-xs text-rose-200">A folder with this name already exists.</p> : null}
              </>
            ) : (
              <span className="text-rose-200">{FOLDER_ERROR_TEXT[preview.data?.folderError ?? ''] ?? 'This folder name cannot be used.'}</span>
            )}
          </div>
        </div>
      )}

      {isSelf ? (
        <Notice tone="warn">
          <span className="font-semibold">This is your own submission.</span> You can approve it, but it will be flagged as self-approved.
        </Notice>
      ) : null}

      {mode === 'deny' ? (
        <div className="space-y-2 rounded-xl border border-ruby/40 bg-ruby/[0.06] p-3">
          <label className="label" htmlFor="deny-reason">
            Reason for denying (required, shown to the submitter)
          </label>
          <textarea id="deny-reason" className="input min-h-[80px]" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-required="true" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-danger" onClick={() => void doDeny()} disabled={busy}>
              {busy ? 'Denying…' : 'Confirm deny'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setMode('idle')} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-approve" onClick={startApprove} disabled={busy}>
            Approve{kind === 'new_artist' ? ' artist' : ''}
          </button>
          <button type="button" className="btn btn-danger" onClick={startDeny} disabled={busy}>
            Deny…
          </button>
        </div>
      )}

      {error ? <Notice tone="error">{error}</Notice> : null}

      <ConfirmDialog
        open={mode === 'approve'}
        title={kind === 'song' ? 'Approve this song?' : 'Approve this artist?'}
        confirmLabel={isSelf ? 'Approve (self-approved)' : 'Approve'}
        confirmClass="btn-approve"
        busy={busy}
        onConfirm={() => void doApprove()}
        onCancel={() => setMode('idle')}
      >
        {kind === 'song' ? (
          <>
            <p>
              “{fields.artist.trim()} – {fields.title.trim()}” goes to the station in:
            </p>
            <ul className="list-disc pl-5">
              {playlists.map((id) => (
                <li key={id}>{assignable.find((a) => a.id === id)?.label ?? `Playlist #${id}`}</li>
              ))}
            </ul>
            {Object.keys(changed).length ? <p className="text-xs text-cream/60">Your metadata edits are saved first.</p> : null}
          </>
        ) : (
          <p>
            Create the folder <code className="text-sunburst">Music/Artists/{preview.data?.proposedFolder}/</code>?
          </p>
        )}
        {isSelf ? <Notice tone="warn">You are approving your own submission. It will be flagged as self-approved.</Notice> : null}
      </ConfirmDialog>
    </section>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = `f-${label.replace(/\W/g, '').toLowerCase()}`
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" value={value} maxLength={200} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
