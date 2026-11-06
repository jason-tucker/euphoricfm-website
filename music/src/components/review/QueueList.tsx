'use client'

// Review queue list with bulk approve. Bulk approve sends one decision per
// selected song with the default playlists, one at a time, and reports each
// result; 409s are listed as "someone else already decided".

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { UiItem } from '@/server/ui/queries'
import { api, ApiError, messageFor } from '../api'
import { ConfirmDialog } from '../ConfirmDialog'
import { soundcloudLabel } from '@/lib/soundcloud'
import { convertedLabel, duration, songName, when } from '../format'
import { Thumb } from '../Thumb'
import { NewArtistBadge, Notice } from '../ui'

export type QueueGroup = { batchId: number; submittedAt: string | null; ownerName: string; ticketNumber: number | null; items: UiItem[] }

type Result = { id: number; name: string; ok: boolean; conflict: boolean; message?: string }

export function QueueList({ groups, defaultPlaylistLabels }: { groups: QueueGroup[]; defaultPlaylistLabels: string[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Result[] | null>(null)

  const all = groups.flatMap((g) => g.items)
  const songs = all.filter((i) => i.kind === 'song')
  const chosen = songs.filter((i) => selected.has(i.id))
  const selfCount = chosen.filter((i) => i.isOwn).length

  const toggle = (id: number, on: boolean) => {
    const s = new Set(selected)
    if (on) s.add(id)
    else s.delete(id)
    setSelected(s)
  }

  const run = async () => {
    setBusy(true)
    const out: Result[] = []
    for (const it of chosen) {
      try {
        await api(`/api/items/${it.id}/decision`, { json: { decision: 'approve' } })
        out.push({ id: it.id, name: songName(it), ok: true, conflict: false })
      } catch (e) {
        const conflict = e instanceof ApiError && e.status === 409
        out.push({ id: it.id, name: songName(it), ok: false, conflict, message: messageFor(e, 'decision') })
      }
    }
    setBusy(false)
    setOpen(false)
    setResults(out)
    setSelected(new Set())
    router.refresh()
  }

  return (
    <div className="space-y-4">
      {results ? (
        <Notice tone={results.every((r) => r.ok) ? 'ok' : 'warn'}>
          <p className="font-semibold">
            Approved {results.filter((r) => r.ok).length} of {results.length}.
          </p>
          {results.some((r) => r.conflict) ? (
            <p className="mt-1 text-xs">
              Someone else already decided:{' '}
              {results
                .filter((r) => r.conflict)
                .map((r) => r.name)
                .join(', ')}
              .
            </p>
          ) : null}
          <ul className="mt-1 list-disc pl-5 text-xs">
            {results
              .filter((r) => !r.ok && !r.conflict)
              .map((r) => (
                <li key={r.id}>
                  {r.name}: {r.message}
                </li>
              ))}
          </ul>
        </Notice>
      ) : null}

      {songs.length ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox"
              checked={chosen.length === songs.length && songs.length > 0}
              onChange={(e) => setSelected(e.target.checked ? new Set(songs.map((s) => s.id)) : new Set())}
            />
            Select all songs
          </label>
          <button type="button" className="btn btn-approve btn-sm" disabled={chosen.length === 0} onClick={() => setOpen(true)}>
            Approve selected ({chosen.length})
          </button>
        </div>
      ) : null}

      {groups.map((g) => (
        <section key={g.batchId} className="card space-y-3" data-queue-batch={g.batchId}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">
              <Link href={`/batches/${g.batchId}`} className="link">
                Batch #{g.batchId}
              </Link>{' '}
              <span className="text-sm font-normal text-cream/60">by {g.ownerName}</span>
            </h2>
            <span className="text-xs text-cream/50">
              {g.submittedAt ? `Submitted ${when(g.submittedAt)}` : ''}
              {g.ticketNumber ? ` · Ticket #${g.ticketNumber}` : ''}
            </span>
          </div>
          <ul className="space-y-2">
            {g.items.map((it) => (
              <li key={it.id} className="flex items-center gap-2">
                {it.kind === 'song' ? (
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label={`Select ${songName(it)}`}
                    checked={selected.has(it.id)}
                    onChange={(e) => toggle(it.id, e.target.checked)}
                  />
                ) : (
                  <span className="size-5 shrink-0" aria-hidden="true" />
                )}
                <Link href={`/review/items/${it.id}`} className="row-link min-w-0 flex-1 text-sm">
                  {it.kind === 'song' ? <Thumb src={it.coverUrl} alt="" size="xs" /> : null}
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    {it.kind === 'new_artist' ? <NewArtistBadge /> : null}
                    <span className="min-w-0 truncate">{it.kind === 'new_artist' ? (it.newArtistName ?? it.artist) : songName(it)}</span>
                    {it.source === 'soundcloud' ? <span className="chip chip-pending">{soundcloudLabel(it.fetchLicense)}</span> : null}
                    {it.isOwn ? <span className="chip chip-pending">yours</span> : null}
                    {convertedLabel(it.inputFormat, it.transcodeKbps) ? <span className="chip chip-neutral">{convertedLabel(it.inputFormat, it.transcodeKbps)}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-cream/50">{duration(it.durationS)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <ConfirmDialog
        open={open}
        title={`Approve ${chosen.length} song${chosen.length === 1 ? '' : 's'}?`}
        confirmLabel="Approve all"
        confirmClass="btn-approve"
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setOpen(false)}
      >
        <p>Each song is approved as submitted, into the default playlist{defaultPlaylistLabels.length === 1 ? '' : 's'}: {defaultPlaylistLabels.join(', ') || '(none set)'}.</p>
        <ul className="max-h-52 list-disc overflow-y-auto pl-5">
          {chosen.map((i) => (
            <li key={i.id}>{songName(i)}</li>
          ))}
        </ul>
        <p className="text-xs text-cream/60">To change metadata or playlists, review songs one at a time instead. New artists are approved separately.</p>
        {selfCount ? <Notice tone="warn">{selfCount} of these are your own submissions and will be flagged as self-approved.</Notice> : null}
      </ConfirmDialog>
    </div>
  )
}
