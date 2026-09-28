'use client'

// v0.3.3: release an Unreleased (legacy) archived song into an artist
// folder. The manager confirms or changes the artist (an existing artist, or
// a new one, created only when "Create this new artist" is ticked) and picks
// the playlists explicitly: none is pre-selected; the playlists it had
// before it was archived are shown as a hint only.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { releaseSong } from '@/lib/api/requests'
import { messageFor } from '../api'
import { Autocomplete } from '../Autocomplete'
import { ConfirmDialog } from '../ConfirmDialog'
import { useDebounced, useJson } from '../hooks'
import { Notice } from '../ui'

type Lookup = { known: { id: number; name: string; folder: string } | null; proposedFolder: string | null; folderError: string | null; folderTaken: boolean }

export function ReleaseButton({
  archiveId,
  name,
  defaultArtist,
  assignable,
  hintLabels,
}: {
  archiveId: number
  name: string
  defaultArtist: string
  assignable: { id: number; label: string }[]
  hintLabels: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [artist, setArtist] = useState(defaultArtist)
  const [create, setCreate] = useState(false)
  const [pl, setPl] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const q = useDebounced(artist.trim(), 300)
  const { data: look } = useJson<Lookup>(open && q ? `/api/ui/artist?name=${encodeURIComponent(q.slice(0, 200))}` : null)
  const isNew = !!look && !look.known
  const blocked = !artist.trim() || !look || (isNew && (!!look.folderError || look.folderTaken || !create))

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await releaseSong(archiveId, { artist: artist.trim(), ...(isNew ? { newArtist: true } : {}), playlistIds: pl })
      setOpen(false)
      setDone(`Queued: “${name}” goes to Music/Artists/${r.folder ?? look?.known?.folder ?? ''}/.`)
      router.refresh()
    } catch (e) {
      setError(messageFor(e, 'edit'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Release…
      </button>
      {done ? <Notice tone="ok">{done}</Notice> : null}
      <ConfirmDialog open={open} title="Release this song?" confirmLabel="Release" busy={busy} confirmDisabled={blocked} onConfirm={() => void go()} onCancel={() => setOpen(false)}>
        <p>“{name}” leaves the archive and goes into the artist’s folder in the library. It keeps its file name; if the folder already has that name it gets “ (2)”. Its title and artist stay as they are.</p>
        <Autocomplete field="artist" label="Artist folder" value={artist} onChange={(v) => { setArtist(v); setCreate(false) }} />
        {look?.known ? (
          <p className="text-xs text-cream/70" data-testid="release-target">
            Goes to Music/Artists/{look.known.folder}/
          </p>
        ) : look && isNew ? (
          look.folderError ? (
            <Notice tone="warn">That name cannot be used as a folder name.</Notice>
          ) : look.folderTaken ? (
            <Notice tone="warn">A different artist already uses the folder “{look.proposedFolder}”. Choose another spelling or an existing artist.</Notice>
          ) : (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
              <span>
                Create this new artist (folder Music/Artists/{look.proposedFolder}/)
              </span>
            </label>
          )
        ) : null}
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-cream/80">Playlists (optional)</legend>
          <div className="flex flex-wrap gap-2">
            {assignable.map((p) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-xl border border-cream/20 bg-cream/[0.04] px-3 py-2 text-sm hover:border-sunburst/50">
                <input type="checkbox" className="checkbox" checked={pl.includes(p.id)} onChange={(e) => setPl(e.target.checked ? [...pl, p.id] : pl.filter((x) => x !== p.id))} />
                {p.label}
              </label>
            ))}
          </div>
          {hintLabels.length ? <p className="text-xs text-cream/55">Before it was archived it was in: {hintLabels.join(', ')} (not selected for you).</p> : null}
          {pl.length === 0 ? <p className="text-xs text-cream/55">No playlist chosen: it will be in the library but not in rotation.</p> : null}
        </fieldset>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </ConfirmDialog>
    </span>
  )
}
