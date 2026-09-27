'use client'

// One file in the submit flow: upload progress / probe state, then the
// pre-filled, editable fields with library autocomplete, the NEW ARTIST badge
// with its proposed folder, duplicate warnings and remove.

import { useEffect } from 'react'
import { AudioPreview } from '../AudioPreview'
import { Autocomplete } from '../Autocomplete'
import { duration } from '../format'
import { useDebounced, useJson } from '../hooks'
import { probeErrorText } from '../messages'
import { NewArtistBadge, Notice } from '../ui'
import { changedFields, type Entry, type Fields, fieldsOf, FIELD_KEYS } from './types'

type ArtistLookup = { known: { name: string; folder: string } | null; proposedFolder: string | null; folderError: string | null; folderTaken: boolean }
type Dup =
  | { kind: 'library'; title: string | null; artist: string | null; album: string | null }
  | { kind: 'item'; itemId: number; batchId: number; title: string | null; artist: string | null; status: string; own: boolean }

export function useArtistLookup(artist: string, enabled: boolean) {
  const a = useDebounced(artist.trim(), 400)
  return useJson<ArtistLookup>(enabled && a ? `/api/ui/artist?name=${encodeURIComponent(a.slice(0, 300))}` : null)
}

const LABELS: Record<keyof Fields, string> = { title: 'Title', artist: 'Artist', album: 'Album', genre: 'Genre' }

export function FileCard({
  entry,
  inBatchDuplicate,
  onEdit,
  onRemove,
  onPause,
  onResume,
  onRetry,
  onNewArtist,
  onDuplicate,
}: {
  entry: Entry
  inBatchDuplicate: boolean
  onEdit: (f: Fields) => void
  onRemove: () => void
  onPause: () => void
  onResume: () => void
  onRetry: () => void
  onNewArtist: (isNew: boolean) => void
  onDuplicate: (isDup: boolean) => void
}) {
  const e = entry
  const ready = e.phase === 'ready'
  const lookup = useArtistLookup(e.edits.artist, ready)
  const t = useDebounced(e.edits.title.trim(), 500)
  const a = useDebounced(e.edits.artist.trim(), 500)
  const dups = useJson<{ results: Dup[] }>(ready && t && a ? `/api/ui/duplicates?title=${encodeURIComponent(t.slice(0, 300))}&artist=${encodeURIComponent(a.slice(0, 300))}${e.itemId ? `&item=${e.itemId}` : ''}` : null)
  const isNew = Boolean(ready && lookup.data && !lookup.data.known)
  const dupList = dups.data?.results ?? []
  const isDup = inBatchDuplicate || dupList.length > 0
  // Report upward for the confirmation summary.
  useEffect(() => onNewArtist(isNew), [isNew]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onDuplicate(isDup), [isDup]) // eslint-disable-line react-hooks/exhaustive-deps
  const base = fieldsOf(e.item)
  const changed = changedFields(e)
  const prefillYear = e.item?.prefill && typeof e.item.prefill.year === 'string' ? e.item.prefill.year : null

  return (
    <li className="card space-y-3" data-entry={e.key} data-phase={e.phase}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium" title={e.fileName}>
            {e.fileName}
          </p>
          <p className="text-xs text-cream/50">
            {(e.size / 1024 / 1024).toFixed(1)} MB
            {e.item?.durationS ? ` · ${duration(e.item.durationS)}` : ''}
            {e.item?.bitrate ? ` · ${Math.round(e.item.bitrate / 1000)} kbps` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {e.phase === 'uploading' ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onPause}>
              Pause
            </button>
          ) : null}
          {e.phase === 'paused' ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onResume}>
              Resume
            </button>
          ) : null}
          {e.phase === 'error' ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
              Retry
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={onRemove}
            disabled={e.phase === 'attaching' || e.phase === 'probing'}
            title={e.phase === 'probing' ? 'You can remove this file once its check finishes' : undefined}
          >
            Remove
          </button>
        </div>
      </div>

      {e.warning ? <Notice tone="warn">{e.warning}</Notice> : null}

      {e.phase === 'blocked' || e.phase === 'error' ? <Notice tone="error">{e.error}</Notice> : null}

      {e.phase === 'queued' || e.phase === 'uploading' || e.phase === 'paused' ? (
        <div>
          <progress className="progress" max={1000} value={Math.round(e.progress * 1000)} aria-label={`Upload progress for ${e.fileName}`} />
          <p className="mt-1 text-xs text-cream/60">
            {e.phase === 'queued' ? 'Waiting to upload…' : e.phase === 'paused' ? `Paused at ${Math.round(e.progress * 100)}%` : `Uploading ${Math.round(e.progress * 100)}%`}
          </p>
        </div>
      ) : null}

      {e.phase === 'attaching' || e.phase === 'probing' ? (
        <p className="text-sm text-sky-300" role="status">
          <span className="mr-2 inline-block size-3 animate-pulse rounded-full bg-sky-300" aria-hidden="true" />
          Checking the file and reading its tags…
        </p>
      ) : null}

      {e.phase === 'rejected' ? <Notice tone="error">{probeErrorText(e.item?.probeError)} This file will not be submitted.</Notice> : null}

      {ready && e.itemId ? (
        <>
          <AudioPreview itemId={e.itemId} />
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELD_KEYS.map((k) => {
              const props = {
                label: `${LABELS[k]}${k === 'title' || k === 'artist' ? ' *' : ''}`,
                value: e.edits[k],
                onChange: (v: string) => onEdit({ ...e.edits, [k]: v }),
              }
              return (
                <div key={k}>
                  {k === 'artist' || k === 'album' ? (
                    <Autocomplete field={k} {...props} />
                  ) : (
                    <div>
                      <label className="label" htmlFor={`${e.key}-${k}`}>
                        {props.label}
                      </label>
                      <input id={`${e.key}-${k}`} className="input" value={props.value} maxLength={200} onChange={(ev) => props.onChange(ev.target.value)} />
                    </div>
                  )}
                  {k in changed ? (
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-cream/55">
                      <span className="chip chip-neutral">edited</span>
                      <span className="truncate">File tag: {base[k] || '(empty)'}</span>
                      <button type="button" className="link" onClick={() => onEdit({ ...e.edits, [k]: base[k] })}>
                        Reset
                      </button>
                    </p>
                  ) : null}
                </div>
              )
            })}
            {prefillYear ? (
              <div>
                <label className="label" htmlFor={`${e.key}-year`}>
                  Year (from file tags)
                </label>
                <input id={`${e.key}-year`} className="input" value={prefillYear} disabled readOnly />
              </div>
            ) : null}
          </div>

          {!e.edits.title.trim() || !e.edits.artist.trim() ? <Notice tone="warn">Title and artist are required.</Notice> : null}

          {isNew && lookup.data ? (
            <div className="rounded-xl border border-gold/50 bg-gold/10 p-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <NewArtistBadge />
                <span>“{e.edits.artist.trim()}” isn&apos;t in the library yet. Managers approve new artists separately.</span>
              </p>
              {lookup.data.proposedFolder ? (
                <p className="mt-1 text-xs text-cream/70">
                  Proposed folder: <code className="rounded bg-ink/60 px-1">Music/Artists/{lookup.data.proposedFolder}/</code>
                  {lookup.data.folderTaken ? ' (a folder with this name already exists; a manager will sort it out)' : ''}
                </p>
              ) : (
                <p className="mt-1 text-xs text-rose-200">This artist name can’t be used as a folder name. Please adjust it.</p>
              )}
            </div>
          ) : null}
          {ready && lookup.data?.known ? <p className="text-xs text-emerald-300">Existing artist · folder “{lookup.data.known.folder}”</p> : null}

          {isDup ? (
            <Notice tone="warn">
              <p className="font-semibold">Possible duplicate</p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {inBatchDuplicate ? <li>Another file in this batch has the same title and artist.</li> : null}
                {dupList.map((d, i) =>
                  d.kind === 'library' ? (
                    <li key={i}>
                      Already in the library: {d.artist} – {d.title}
                      {d.album ? ` (${d.album})` : ''}
                    </li>
                  ) : (
                    <li key={i}>
                      {d.own ? 'You already submitted' : 'Already submitted'}: {d.artist} – {d.title} (batch #{d.batchId}, {d.status})
                    </li>
                  ),
                )}
              </ul>
              <p className="mt-1 text-xs">You can still submit it if it’s a different version.</p>
            </Notice>
          ) : null}
        </>
      ) : null}
    </li>
  )
}
