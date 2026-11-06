'use client'

// Manager tools for one library song: direct metadata edit, playlist
// membership (only the assignable set is editable; other memberships are
// kept by the server's merge), and archive.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { archiveSong, directEdit, setLibraryArt, setPlaylists, type Proposed } from '@/lib/api/requests'
import { ArtControl } from '../ArtControl'
import { messageFor } from '../api'
import { ConfirmDialog } from '../ConfirmDialog'
import { Notice } from '../ui'

type Fields = { title: string; artist: string; album: string; genre: string }
const KEYS = ['title', 'artist', 'album', 'genre'] as const

export function ManagerTools({
  mediaId,
  current,
  artUrl = null,
  playlistIds,
  assignable,
  otherPlaylistLabels,
}: {
  mediaId: number
  current: Fields
  artUrl?: string | null
  playlistIds: number[]
  assignable: { id: number; label: string }[]
  otherPlaylistLabels: string[]
}) {
  const router = useRouter()
  const [f, setF] = useState<Fields>(current)
  const [pl, setPl] = useState<number[]>(playlistIds.filter((id) => assignable.some((a) => a.id === id)))
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveReason, setArchiveReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label)
    setMsg(null)
    try {
      await fn()
      setMsg({ tone: 'ok', text: ok })
      router.refresh()
    } catch (e) {
      setMsg({ tone: 'error', text: messageFor(e, 'edit') })
    } finally {
      setBusy(null)
    }
  }

  const changes: Proposed = {}
  for (const k of KEYS) if (f[k].trim() !== current[k].trim() && f[k].trim()) changes[k] = f[k].trim()
  const plChanged = JSON.stringify([...pl].sort()) !== JSON.stringify(playlistIds.filter((id) => assignable.some((a) => a.id === id)).sort())

  return (
    <section className="card space-y-5" aria-label="Manager tools">
      <h2 className="text-lg font-bold">Manager tools</h2>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-cream/80">Edit metadata</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {KEYS.map((k) => (
            <div key={k}>
              <label className="label capitalize" htmlFor={`mg-${k}`}>
                {k}
              </label>
              <input id={`mg-${k}`} className="input" value={f[k]} maxLength={200} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || Object.keys(changes).length === 0} onClick={() => void run('edit', () => directEdit(mediaId, changes), 'Saved. The station copy updates shortly.')}>
          {busy === 'edit' ? 'Saving…' : 'Save metadata'}
        </button>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-cream/80">Album art</h3>
        <ArtControl
          src={artUrl}
          title="Station album art"
          prompt="This song has no album art on the station. Upload some to set it (optional)."
          attach={async (artId) => {
            await setLibraryArt(mediaId, artId)
            setMsg({ tone: 'ok', text: 'New art queued. The station copy updates shortly.' })
          }}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-cream/80">Playlists</legend>
        <div className="flex flex-wrap gap-2">
          {assignable.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-xl border border-cream/20 bg-cream/[0.04] px-3 py-2 text-sm hover:border-sunburst/50">
              <input type="checkbox" className="checkbox" checked={pl.includes(p.id)} onChange={(e) => setPl(e.target.checked ? [...pl, p.id] : pl.filter((x) => x !== p.id))} />
              {p.label}
            </label>
          ))}
        </div>
        {otherPlaylistLabels.length ? <p className="text-xs text-cream/55">Also in (not editable here, always kept): {otherPlaylistLabels.join(', ')}</p> : null}
        <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy || !plChanged} onClick={() => void run('pl', () => setPlaylists(mediaId, pl), 'Playlists updated.')}>
          {busy === 'pl' ? 'Saving…' : 'Save playlists'}
        </button>
      </fieldset>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-cream/80">Archive</h3>
        <p className="text-xs text-cream/60">Takes the song out of every playlist and moves it to the archive. Nothing is deleted; it can be restored.</p>
        <button type="button" className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => setArchiveOpen(true)}>
          Archive this song…
        </button>
      </div>

      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}

      <ConfirmDialog
        open={archiveOpen}
        title="Archive this song?"
        confirmLabel="Archive"
        confirmClass="btn-danger"
        busy={busy === 'archive'}
        onConfirm={() => {
          setArchiveOpen(false)
          void run('archive', () => archiveSong(mediaId, archiveReason.trim()), 'Archived. It is listed under Archived songs, where it can be restored.')
        }}
        onCancel={() => setArchiveOpen(false)}
      >
        <p>It leaves rotation right away (after the current play) and can be restored from Archived songs.</p>
        <label className="label" htmlFor="archive-reason">
          Reason (optional)
        </label>
        <textarea id="archive-reason" className="input" maxLength={500} value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} />
      </ConfirmDialog>
    </section>
  )
}
