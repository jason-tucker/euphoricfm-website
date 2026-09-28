'use client'

// The submit flow: drag-and-drop multi-file MP3 / WAV upload over tus (per-file
// progress, pause/resume, and resume after a reload via the tus fingerprint),
// attach each finished upload to the draft batch, poll until the network-less
// probe has read it, then edit the pre-filled fields and submit.

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as tus from 'tus-js-client'
import { MAX_DURATION_MIN, mibOf, MIN_LADDER_BITRATE } from '@/lib/fit'
import { parseSoundCloudUrl } from '@/lib/soundcloud'
import type { UiItem } from '@/server/ui/queries'
import { api, ApiError, messageFor } from '../api'
import { errorText, uploadErrorText } from '../messages'
import { Notice } from '../ui'
import { FileCard } from './FileCard'
import { SubmitPanel, type SummaryRow } from './SubmitPanel'
import { ACCEPT, changedFields, declaredType, type Entry, type Fields, fieldsOf, type Limits, precheck } from './types'

// The server allows 3 concurrent uploads per user; 2 leaves headroom for a
// stale upload that has not expired yet.
const CONCURRENCY = 2
const POLL_MS = [1000, 1500, 2000, 3000, 4000, 5000]

type ItemApi = Pick<
  UiItem,
  'id' | 'batchId' | 'status' | 'title' | 'artist' | 'album' | 'genre' | 'durationS' | 'bitrate' | 'probeError' | 'hasCover' | 'inputFormat' | 'transcodeKbps' | 'source' | 'fetchStage' | 'fetchLicense' | 'sourceUrl'
> & {
  prefill?: unknown
}

function entryFromItem(it: UiItem): Entry {
  return {
    key: `item-${it.id}`,
    source: it.source === 'soundcloud' ? 'soundcloud' : 'upload',
    fileName: it.title ? `${it.artist ?? ''}${it.artist ? ' – ' : ''}${it.title}` : it.source === 'soundcloud' && it.sourceUrl ? it.sourceUrl : `Upload #${it.id}`,
    size: 0,
    phase: it.status === 'probing' ? 'probing' : it.status === 'rejected' ? 'rejected' : 'ready',
    progress: 1,
    itemId: it.id,
    item: it,
    edits: fieldsOf(it),
  }
}

function tusErrorText(err: unknown, limits: Limits): string {
  const e = err as { originalResponse?: { getStatus(): number; getBody(): string } | null }
  const status = e.originalResponse?.getStatus() ?? 0
  if (!status) return errorText('network')
  const body = e.originalResponse?.getBody() ?? ''
  let code = ''
  try {
    const j = JSON.parse(body) as { error?: string }
    code = typeof j.error === 'string' ? j.error : ''
  } catch {
    code = body.trim().split(/\s/)[0] ?? ''
  }
  return code ? uploadErrorText(code, status, limits) : errorText(`http_${status}`, status)
}

export function SubmitFlow({
  initialBatchId,
  initialItems,
  rights,
  maxMp3UploadBytes,
  maxWavUploadBytes,
  chunkBytes,
  maxItemsPerBatch,
}: {
  initialBatchId: number | null
  initialItems: UiItem[]
  rights: { version: string; text: string }
  // Per-file INPUT caps (the loaded, possibly admin-lowered caps). Not the
  // 35 MB final-file cap: a bigger MP3 is converted down by the probe.
  maxMp3UploadBytes: number
  maxWavUploadBytes: number
  chunkBytes: number
  maxItemsPerBatch: number
}) {
  const router = useRouter()
  const [entries, setEntries] = useState<Entry[]>(() =>
    initialItems.filter((i) => i.kind === 'song' && i.status !== 'withdrawn').map(entryFromItem),
  )
  const [batchId, setBatchId] = useState<number | null>(initialBatchId)
  const [flags, setFlags] = useState<Record<string, { newArtist?: boolean; dup?: boolean; art?: boolean }>>({})
  const [notes, setNotes] = useState('')
  const [dragging, setDragging] = useState(false)
  const [topError, setTopError] = useState<string | null>(null)
  const [scUrl, setScUrl] = useState('')
  const [scError, setScError] = useState<string | null>(null)
  const [scBusy, setScBusy] = useState(false)

  const batchRef = useRef<Promise<number> | null>(initialBatchId ? Promise.resolve(initialBatchId) : null)
  const files = useRef(new Map<string, File>())
  const uploads = useRef(new Map<string, tus.Upload>())
  const active = useRef(new Set<string>())
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const mounted = useRef(true)

  const update = useCallback((key: string, patch: Partial<Entry> | ((e: Entry) => Partial<Entry>)) => {
    setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...(typeof patch === 'function' ? patch(e) : patch) } : e)))
  }, [])
  const drop = useCallback((key: string) => {
    setEntries((es) => es.filter((e) => e.key !== key))
    files.current.delete(key)
    uploads.current.delete(key)
    active.current.delete(key)
  }, [])

  const ensureBatch = useCallback(async (): Promise<number> => {
    if (!batchRef.current) {
      batchRef.current = api<{ id: number }>('/api/batches', { method: 'POST' })
        .then((b) => {
          setBatchId(b.id)
          // Keep the draft on reload without re-rendering the server page.
          window.history.replaceState(null, '', `/submit?batch=${b.id}`)
          return b.id
        })
        .catch((e) => {
          batchRef.current = null
          throw e
        })
    }
    return batchRef.current
  }, [])

  const poll = useCallback(
    async (key: string, itemId: number) => {
      for (let i = 0; mounted.current; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS[Math.min(i, POLL_MS.length - 1)]))
        if (!mounted.current) return
        let it: ItemApi
        try {
          it = await api<ItemApi>(`/api/items/${itemId}`)
        } catch (e) {
          if (e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429)) continue
          update(key, { phase: 'error', error: messageFor(e) })
          return
        }
        if (it.status === 'probing') {
          // A SoundCloud link reports where it is (fetch_stage) while it waits.
          if (it.source === 'soundcloud') update(key, (x) => ({ item: { ...(x.item ?? {}), ...it } as UiItem }))
          continue
        }
        const item = { ...(entriesRef.current.find((x) => x.key === key)?.item ?? {}), ...it } as UiItem
        if (it.status === 'rejected') update(key, { phase: 'rejected', item })
        else if (it.status === 'withdrawn') drop(key)
        else update(key, { phase: 'ready', item, edits: fieldsOf(item) })
        return
      }
    },
    [update, drop],
  )

  const attach = useCallback(
    async (key: string, url: string | null) => {
      const m = /([0-9a-f]{32})\/?$/.exec(url ?? '')
      if (!m) {
        update(key, { phase: 'error', error: 'The upload finished but its id was not returned. Remove the file and add it again.' })
        return
      }
      update(key, { phase: 'attaching', progress: 1, uploadUrl: url ?? undefined, error: undefined })
      try {
        const bid = await ensureBatch()
        const r = await api<{ id: number }>(`/api/batches/${bid}/items`, { json: { uploadId: m[1] } })
        update(key, { phase: 'probing', itemId: r.id })
        void poll(key, r.id)
      } catch (e) {
        update(key, { phase: 'error', error: messageFor(e) })
      }
    },
    [ensureBatch, poll, update],
  )

  const pumpRef = useRef<() => void>(() => {})

  const startUpload = useCallback(
    async (key: string) => {
      const file = files.current.get(key)
      if (!file) return
      active.current.add(key)
      update(key, { phase: 'uploading', error: undefined })
      try {
        await ensureBatch()
      } catch (e) {
        active.current.delete(key)
        update(key, { phase: 'error', error: messageFor(e) })
        pumpRef.current()
        return
      }
      const up = new tus.Upload(file, {
        endpoint: '/api/uploads',
        chunkSize: chunkBytes,
        // The server caps the upload by this declared type (MP3 100 MB, WAV
        // 250 MB); the probe checks the real type from the bytes.
        metadata: { filetype: declaredType(file) },
        retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        onProgress: (sent, total) => update(key, { progress: total ? sent / total : 0 }),
        onShouldRetry: (err) => {
          const s = (err as { originalResponse?: { getStatus(): number } | null }).originalResponse?.getStatus() ?? 0
          return s === 0 || s === 423 || s === 429 || s >= 500
        },
        onError: (err) => {
          active.current.delete(key)
          if (mounted.current) update(key, { phase: 'error', error: tusErrorText(err, { mp3: maxMp3UploadBytes, wav: maxWavUploadBytes }) })
          pumpRef.current()
        },
        onSuccess: () => {
          active.current.delete(key)
          pumpRef.current()
          void attach(key, up.url)
        },
      })
      uploads.current.set(key, up)
      try {
        const prev = await up.findPreviousUploads()
        if (prev.length) up.resumeFromPreviousUpload(prev[0]!)
      } catch {
        // no stored fingerprint: start fresh
      }
      up.start()
    },
    [attach, chunkBytes, ensureBatch, maxMp3UploadBytes, maxWavUploadBytes, update],
  )

  const pump = useCallback(() => {
    const queued = entriesRef.current.filter((e) => e.phase === 'queued' && !active.current.has(e.key))
    for (const e of queued) {
      if (active.current.size >= CONCURRENCY) break
      void startUpload(e.key)
    }
  }, [startUpload])
  pumpRef.current = pump

  // Kick the queue after every state change that may have freed a slot.
  useEffect(() => {
    pump()
  }, [entries, pump])

  useEffect(() => {
    mounted.current = true
    for (const e of entriesRef.current) if (e.phase === 'probing' && e.itemId) void poll(e.key, e.itemId)
    const ups = uploads.current
    return () => {
      mounted.current = false
      // Stop without terminating: the fingerprint lets the same file resume.
      for (const u of ups.values()) void u.abort(false)
    }
  }, [poll])

  const addFiles = (list: FileList | File[]) => {
    setTopError(null)
    const added: Entry[] = []
    for (const f of Array.from(list)) {
      const key = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      const c = precheck(f, { mp3: maxMp3UploadBytes, wav: maxWavUploadBytes })
      files.current.set(key, f)
      added.push({ key, fileName: f.name, size: f.size, phase: c.block ? 'blocked' : 'queued', progress: 0, warning: c.warn, error: c.block, edits: fieldsOf(undefined) })
    }
    setEntries((es) => [...es, ...added])
  }

  // v0.4.0: a SoundCloud link. The shape is checked here first (the same
  // rules as the server's), then the server records it and the worker fetches
  // it; the card then follows it like an uploaded file.
  const addLink = async () => {
    setScError(null)
    const p = parseSoundCloudUrl(scUrl)
    if (!p.ok) {
      setScError(errorText(p.code))
      return
    }
    setScBusy(true)
    try {
      const bid = await ensureBatch()
      const r = await api<{ id: number; url: string }>(`/api/batches/${bid}/soundcloud`, { json: { url: p.url } })
      const key = `sc-${r.id}`
      setEntries((es) => [...es, { key, source: 'soundcloud', fileName: r.url, size: 0, phase: 'probing', progress: 1, itemId: r.id, edits: fieldsOf(undefined) }])
      setScUrl('')
      void poll(key, r.id)
    } catch (err) {
      setScError(messageFor(err))
    } finally {
      setScBusy(false)
    }
  }

  const remove = async (e: Entry) => {
    const up = uploads.current.get(e.key)
    if (e.phase === 'uploading' || e.phase === 'paused' || e.phase === 'queued' || e.phase === 'error') {
      // Terminate the partial upload on the server (DELETE); ignore failures.
      if (up) await up.abort(true).catch(() => {})
      drop(e.key)
      return
    }
    if (e.phase === 'ready' && e.itemId) {
      try {
        await api(`/api/items/${e.itemId}/withdraw`, { method: 'POST' })
        drop(e.key)
      } catch (err) {
        update(e.key, { error: undefined })
        setTopError(messageFor(err, 'withdraw'))
      }
      return
    }
    drop(e.key)
  }

  const ready = entries.filter((e) => e.phase === 'ready')
  const busy = entries.filter((e) => ['queued', 'uploading', 'paused', 'attaching', 'probing'].includes(e.phase))
  const dupKeys = useMemo(() => {
    const seen = new Map<string, string[]>()
    for (const e of entries) {
      if (e.phase !== 'ready') continue
      const k = `${e.edits.artist.trim().toLowerCase()}|${e.edits.title.trim().toLowerCase()}`
      if (k === '|') continue
      seen.set(k, [...(seen.get(k) ?? []), e.key])
    }
    return new Set([...seen.values()].filter((v) => v.length > 1).flat())
  }, [entries])

  const blockers: string[] = []
  if (busy.length) blockers.push('Wait until every file has finished uploading and checking.')
  if (ready.length === 0) blockers.push('Add at least one song that passed the checks.')
  if (ready.some((e) => !e.edits.title.trim() || !e.edits.artist.trim())) blockers.push('Every song needs a title and an artist.')
  if (ready.length > maxItemsPerBatch) blockers.push(`A batch can hold up to ${maxItemsPerBatch} songs. Remove some and submit them in another batch.`)

  const rows: SummaryRow[] = ready.map((e) => ({
    key: e.key,
    name: `${e.edits.artist.trim()} – ${e.edits.title.trim()}`,
    newArtist: Boolean(flags[e.key]?.newArtist),
    edited: Object.keys(changedFields(e)).length > 0,
    duplicate: Boolean(flags[e.key]?.dup),
    noArt: !(flags[e.key]?.art ?? e.item?.hasArt ?? e.item?.hasCover ?? false),
  }))

  const onSubmit = async (att: { attest: true; version: string }): Promise<string | null> => {
    const bid = batchId ?? (await ensureBatch().catch(() => null))
    if (!bid) return errorText('internal')
    // 1. Save per-field overrides.
    for (const e of ready) {
      const ch = changedFields(e)
      if (!e.itemId || Object.keys(ch).length === 0) continue
      try {
        await api(`/api/items/${e.itemId}`, { method: 'PATCH', json: ch })
      } catch (err) {
        return `Couldn't save your changes to “${e.edits.title}”: ${messageFor(err, 'edit')}`
      }
    }
    // 2. Submit with the attestation.
    try {
      await api(`/api/batches/${bid}/submit`, { json: { attest: att.attest, attestVersion: att.version } })
    } catch (err) {
      return messageFor(err, 'submit')
    }
    // 3. Notes go into the batch thread (and on to the ticket).
    let notesFailed = false
    if (notes.trim()) {
      try {
        await api(`/api/batches/${bid}/comments`, { json: { body: notes.trim(), visibility: 'all' } })
      } catch {
        notesFailed = true
      }
    }
    router.push(`/batches/${bid}?submitted=1${notesFailed ? '&notes=failed' : ''}`)
    return null
  }

  const setFlag = (key: string, k: 'newArtist' | 'dup' | 'art', v: boolean) =>
    setFlags((f) => (f[key]?.[k] === v ? f : { ...f, [key]: { ...f[key], [k]: v } }))

  return (
    <div className="space-y-6">
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">1. Add your songs</h2>
          {batchId ? <span className="text-xs text-cream/50">Draft batch #{batchId} · saved automatically</span> : null}
        </div>
        <label
          htmlFor="file-input"
          className="dropzone"
          data-active={dragging ? 'true' : 'false'}
          onDragOver={(ev) => {
            ev.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(ev) => {
            ev.preventDefault()
            setDragging(false)
            if (ev.dataTransfer.files.length) addFiles(ev.dataTransfer.files)
          }}
        >
          <span className="text-3xl" aria-hidden="true">
            ♫
          </span>
          <span className="font-semibold">Drop MP3 or WAV files here</span>
          <span className="btn btn-secondary btn-sm pointer-events-none">or choose files</span>
          <span className="text-xs text-cream/55">
            MP3: up to {mibOf(maxMp3UploadBytes)} MB each · 30 s to {MAX_DURATION_MIN} min · at least 128 kbps
          </span>
          <span className="text-xs text-cream/55">
            WAV: up to {mibOf(maxWavUploadBytes)} MB each · 30 s to {MAX_DURATION_MIN} min · converted to an MP3 for you
          </span>
          <span className="text-xs text-cream/55">
            Big files are converted down (as low as {MIN_LADDER_BITRATE / 1000} kbps) so they fit. An MP3 that already fits is never changed.
          </span>
        </label>
        <input
          id="file-input"
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          onChange={(ev) => {
            if (ev.target.files?.length) addFiles(ev.target.files)
            ev.target.value = ''
          }}
        />
        <p className="text-xs text-cream/50">If your connection drops or you reload the page, add the same files again and they continue where they stopped.</p>

        <form
          noValidate
          className="space-y-2 rounded-xl border border-cream/15 p-3"
          data-testid="sc-form"
          onSubmit={(ev) => {
            ev.preventDefault()
            if (!scBusy) void addLink()
          }}
        >
          <label htmlFor="sc-link" className="block font-semibold">
            Add from a SoundCloud link
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="sc-link"
              className="input min-w-0 flex-1"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
              placeholder="https://soundcloud.com/artist/track-name"
              value={scUrl}
              aria-describedby="sc-help"
              aria-invalid={scError ? 'true' : undefined}
              onChange={(ev) => {
                setScUrl(ev.target.value)
                if (scError) setScError(null)
              }}
            />
            <button type="submit" className="btn btn-primary" disabled={scBusy} data-testid="sc-add">
              <span aria-hidden="true">＋</span> {scBusy ? 'Adding…' : 'Add from SoundCloud'}
            </button>
          </div>
          <p id="sc-help" className="text-xs text-cream/55">
            One public track per link (no playlists or sets). We download it for you, convert it to an MP3 and fill in the title, artist and genre from SoundCloud; you can edit them. 30 s to {MAX_DURATION_MIN} min.
          </p>
          {scError ? (
            <p className="text-sm text-rose-200" role="alert">
              {scError}
            </p>
          ) : null}
        </form>
      </section>

      {topError ? <Notice tone="error">{topError}</Notice> : null}

      {entries.length ? (
        <section aria-labelledby="files-h">
          <h2 id="files-h" className="mb-3 text-lg font-bold">
            2. Check the details
          </h2>
          <ul className="space-y-4">
            {entries.map((e) => (
              <FileCard
                key={e.key}
                entry={e}
                inBatchDuplicate={dupKeys.has(e.key)}
                onEdit={(f: Fields) => update(e.key, { edits: f })}
                onRemove={() => void remove(e)}
                onPause={() => {
                  void uploads.current.get(e.key)?.abort(false)
                  active.current.delete(e.key)
                  update(e.key, { phase: 'paused' })
                }}
                onResume={() => {
                  const up = uploads.current.get(e.key)
                  if (!up) return update(e.key, { phase: 'queued' })
                  active.current.add(e.key)
                  update(e.key, { phase: 'uploading' })
                  up.start()
                }}
                onRetry={() => {
                  if (e.itemId) {
                    update(e.key, { phase: 'probing', error: undefined })
                    void poll(e.key, e.itemId)
                  } else if (e.uploadUrl) void attach(e.key, e.uploadUrl)
                  else update(e.key, { phase: 'queued', error: undefined })
                }}
                onNewArtist={(v) => setFlag(e.key, 'newArtist', v)}
                onDuplicate={(v) => setFlag(e.key, 'dup', v)}
                onArt={(v) => setFlag(e.key, 'art', v)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <SubmitPanel rights={rights} rows={rows} blockers={blockers} notes={notes} onNotes={setNotes} onSubmit={onSubmit} />
    </div>
  )
}
