'use client'

// Member request forms for a library song: suggest an edit (only changed
// fields are sent, as `proposed`) or ask for removal (reason required).
// Each request opens its own ticket.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { fileEditRequest, fileRemovalRequest, type ArtId, type Proposed } from '@/lib/api/requests'
import { ArtControl } from '../ArtControl'
import { messageFor } from '../api'
import { Autocomplete } from '../Autocomplete'
import { ConfirmDialog } from '../ConfirmDialog'
import { Notice } from '../ui'

type Fields = { title: string; artist: string; album: string; genre: string }
const KEYS = ['title', 'artist', 'album', 'genre'] as const

export function proposedChanges(current: Fields, edits: Fields): Proposed {
  const out: Proposed = {}
  for (const k of KEYS) {
    const v = edits[k].trim()
    if (v !== (current[k] ?? '').trim() && v !== '') out[k] = v
  }
  return out
}

export function RequestForms({
  mediaId,
  current,
  currentArtUrl = null,
  initialTab = 'edit',
}: {
  mediaId: number
  current: Fields
  currentArtUrl?: string | null
  initialTab?: 'edit' | 'removal'
}) {
  const router = useRouter()
  const [tab, setTab] = useState<'edit' | 'removal'>(initialTab)
  const [edits, setEdits] = useState<Fields>(current)
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [artId, setArtId] = useState<ArtId | null>(null)
  const [artPreview, setArtPreview] = useState<string | null>(null)
  const changes: Proposed = { ...proposedChanges(current, edits), ...(artId !== null ? { artId } : {}) }

  const open = () => {
    setError(null)
    if (tab === 'edit' && Object.keys(changes).length === 0) return setError('Change at least one field, or propose new album art, to suggest an edit.')
    if (tab === 'removal' && !reason.trim()) return setError('Tell the managers why this song should be removed.')
    setConfirm(true)
  }

  const send = async () => {
    setBusy(true)
    try {
      const r = tab === 'edit' ? await fileEditRequest(mediaId, changes, reason.trim()) : await fileRemovalRequest(mediaId, reason.trim())
      setDone(`Request #${r.id} was filed. A ticket opens in Discord, and you can follow it from My music.`)
      setConfirm(false)
      router.refresh()
    } catch (e) {
      setConfirm(false)
      setError(messageFor(e))
    } finally {
      setBusy(false)
    }
  }

  if (done) return <Notice tone="ok">{done}</Notice>

  return (
    <section className="card space-y-4" aria-label="Request a change">
      <div role="tablist" className="flex flex-wrap gap-2">
        <button type="button" role="tab" aria-selected={tab === 'edit'} className={`btn btn-sm ${tab === 'edit' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('edit')}>
          Suggest an edit
        </button>
        <button type="button" role="tab" aria-selected={tab === 'removal'} className={`btn btn-sm ${tab === 'removal' ? 'btn-danger' : 'btn-secondary'}`} onClick={() => setTab('removal')}>
          Request removal
        </button>
      </div>

      {tab === 'edit' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="rq-title" label="Title" value={edits.title} was={current.title} onChange={(v) => setEdits({ ...edits, title: v })} />
          <div>
            <Autocomplete field="artist" label="Artist" value={edits.artist} onChange={(v) => setEdits({ ...edits, artist: v })} />
            {edits.artist.trim() !== current.artist.trim() ? <p className="mt-1 text-xs text-cream/55">Now: {current.artist || '(empty)'} · changing the artist moves the file to that artist’s folder</p> : null}
          </div>
          <div>
            <Autocomplete field="album" label="Album" value={edits.album} onChange={(v) => setEdits({ ...edits, album: v })} />
            {edits.album.trim() !== current.album.trim() ? <p className="mt-1 text-xs text-cream/55">Now: {current.album || '(empty)'}</p> : null}
          </div>
          <TextField id="rq-genre" label="Genre" value={edits.genre} was={current.genre} onChange={(v) => setEdits({ ...edits, genre: v })} />
          <div className="sm:col-span-2">
            <ArtControl
              src={currentArtUrl}
              title={artId !== null ? 'New album art (proposed)' : 'Current album art'}
              prompt="This song has no album art. You can propose some (optional)."
              canRemove={false}
              removeLabel="Undo new art"
              attach={async (id, preview) => {
                setArtId(id)
                setArtPreview(preview)
              }}
              detach={async () => {
                setArtId(null)
                setArtPreview(null)
                return currentArtUrl
              }}
            />
          </div>
        </div>
      ) : (
        <p className="text-sm text-cream/75">Removed songs are archived (taken out of every playlist and moved out of the library), not deleted. Managers can restore them.</p>
      )}

      <div>
        <label className="label" htmlFor="rq-reason">
          {tab === 'removal' ? 'Why should it be removed? (required)' : 'Why? (optional)'}
        </label>
        <textarea id="rq-reason" className="input min-h-[70px]" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <button type="button" className={`btn ${tab === 'removal' ? 'btn-danger' : 'btn-primary'}`} onClick={open} disabled={busy}>
        {tab === 'edit' ? 'Send edit request' : 'Send removal request'}
      </button>

      <ConfirmDialog
        open={confirm}
        title={tab === 'edit' ? 'Send this edit request?' : 'Send this removal request?'}
        confirmLabel="Send request"
        confirmClass={tab === 'removal' ? 'btn-danger' : 'btn-primary'}
        busy={busy}
        onConfirm={() => void send()}
        onCancel={() => setConfirm(false)}
      >
        {tab === 'edit' ? (
          <ul className="list-disc pl-5">
            {Object.entries(changes).map(([k, v]) =>
              k === 'artId' ? (
                <li key={k}>New album art{artPreview ? ' (shown above)' : ''}</li>
              ) : (
                <li key={k}>
                  <span className="capitalize">{k}</span>: “{current[k as keyof Fields] || '(empty)'}” → “{String(v)}”
                </li>
              ),
            )}
          </ul>
        ) : (
          <p>Ask the managers to archive this song.</p>
        )}
        <p className="text-xs text-cream/60">This opens a ticket in Discord so you can talk it through with the managers.</p>
      </ConfirmDialog>
    </section>
  )
}

function TextField({ id, label, value, was, onChange }: { id: string; label: string; value: string; was: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" value={value} maxLength={200} onChange={(e) => onChange(e.target.value)} />
      {value.trim() !== was.trim() ? <p className="mt-1 text-xs text-cream/55">Now: {was || '(empty)'}</p> : null}
    </div>
  )
}
