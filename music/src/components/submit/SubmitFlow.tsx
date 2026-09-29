'use client'

// The submit flow: drag-and-drop multi-file MP3 / WAV upload over tus (per-file
// progress, pause/resume, and resume after a reload via the tus fingerprint),
// attach each finished upload to the draft batch, poll until the network-less
// probe has read it, then edit the pre-filled fields and submit.
//
// v0.4.1 polling: ONE request per tick for the whole batch (GET
// /api/batches/:id), every 5 s, then 15 s, then 30 s while nothing changes
// (a change or a new item resets it), and none while the tab is hidden.

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as tus from 'tus-js-client'
import { AUDIO_PAYLOAD_BYTES, MAX_DURATION_MIN, mibOf, MIN_LADDER_BITRATE } from '@/lib/fit'
import { FETCH_INFLIGHT_PER_USER, parseSoundCloudUrl } from '@/lib/soundcloud'
import type { UiItem } from '@/server/ui/queries'
import { api, ApiError, messageFor } from '../api'
import { errorText, uploadErrorText } from '../messages'
import { Notice } from '../ui'
import { FileCard } from './FileCard'
import { SubmitPanel, type SummaryRow } from './SubmitPanel'
import { ACCEPT, changedFields, declaredType, type Entry, type Fields, fieldsOf, fileKind, id3TagBytes, type Limits, precheck } from './types'

// The server allows 3 concurrent uploads per user; 2 leaves headroom for a
// stale upload that has not expired yet.
const CONCURRENCY = 2
export const POLL_MS = [5000, 15000, 30000]

type ItemApi = Pick<
  UiItem,
  'id' | 'batchId' | 'status' | 'title' | 'artist' | 'album' | 'genre' | 'durationS' | 'bitrate' | 'probeError' | 'hasCover' | 'inputFormat' | 'transcodeKbps' | 'source' | 'fetchStage' | 'fetchLicense' | 'sourceUrl'
> & {
  prefill?: unknown
}

// The card heading of an item from the server: "Artist – Title" once there is
// a title, else a SoundCloud item's link, else `fallback`.
export function songLabel(it: Pick<UiItem, 'title' | 'artist' | 'source' | 'sourceUrl'>, fallback: string): string {
  if (it.title) return `${it.artist ?? ''}${it.artist ? ' – ' : ''}${it.title}`
  return it.source === 'soundcloud' && it.sourceUrl ? it.sourceUrl : fallback
}

function entryFromItem(it: UiItem): Entry {
  return {
    key: `item-${it.id}`,
    source: it.source === 'soundcloud' ? 'soundcloud' : 'upload',
    fileName: songLabel(it, `Upload #${it.id}`),
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
  soundcloudEnabled = true,
  fetchesPerDay,
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
  // v0.4.1: the kill switch (off: the SoundCloud box is one muted line) and
  // the loaded daily link cap (caps.fetchesPerUserPerDay) for the help text.
  soundcloudEnabled?: boolean
  fetchesPerDay?: number
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

  // --- polling (one request per tick for every probing item) -------------
  const pollTick = useRef(0)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollBusy = useRef(false)
  const pollOnceRef = useRef<() => Promise<void>>(async () => {})

  const schedulePoll = useCallback((reset = false) => {
    if (reset) pollTick.current = 0
    if (pollTimer.current) clearTimeout(pollTimer.current)
    pollTimer.current = null
    // A request in flight schedules the next one itself; a hidden tab
    // resumes on visibilitychange.
    if (!mounted.current || pollBusy.current || document.hidden) return
    if (!entriesRef.current.some((e) => e.phase === 'probing' && e.itemId)) return
    pollTimer.current = setTimeout(() => void pollOnceRef.current(), POLL_MS[Math.min(pollTick.current, POLL_MS.length - 1)])
  }, [])

  pollOnceRef.current = async () => {
    pollTimer.current = null
    const bid = batchRef.current ? await batchRef.current.catch(() => null) : null
    if (!bid || !mounted.current || document.hidden) return
    pollBusy.current = true
    pollTick.current++
    let got: { items: ItemApi[] } | null = null
    let gaveUp = false
    try {
      got = await api<{ items: ItemApi[] }>(`/api/batches/${bid}`)
    } catch (e) {
      if (!(e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429))) {
        const msg = messageFor(e)
        for (const x of entriesRef.current) if (x.phase === 'probing' && x.itemId) update(x.key, { phase: 'error', error: msg })
        gaveUp = true
      }
    } finally {
      pollBusy.current = false
    }
    if (!mounted.current) return
    // (entriesRef lags behind the updates below until the next render.)
    let left = gaveUp ? 0 : entriesRef.current.filter((x) => x.phase === 'probing' && x.itemId).length
    if (got) {
      const byId = new Map(got.items.map((it) => [it.id, it]))
      let changed = false
      for (const x of entriesRef.current) {
        if (x.phase !== 'probing' || !x.itemId) continue
        const it = byId.get(x.itemId)
        if (!it) continue
        if (it.status !== 'probing') left--
        if (it.status === 'probing') {
          // A SoundCloud link reports where it is (fetch_stage) while it
          // waits; nothing is re-rendered while that stays the same.
          if (it.source === 'soundcloud' && it.fetchStage !== x.item?.fetchStage) {
            changed = true
            update(x.key, (y) => ({ item: { ...(y.item ?? {}), ...it } as UiItem }))
          }
          continue
        }
        changed = true
        const item = { ...(x.item ?? {}), ...it } as UiItem
        if (it.status === 'rejected') update(x.key, { phase: 'rejected', item })
        else if (it.status === 'withdrawn') drop(x.key)
        else update(x.key, (y) => ({ phase: 'ready', item, edits: fieldsOf(item), fileName: y.source === 'soundcloud' ? songLabel(item, y.fileName) : y.fileName }))
      }
      if (changed) pollTick.current = 0
    }
    if (left > 0) schedulePoll()
  }

  // A new item to follow (an upload attached, a link added, a retry, a
  // reload) starts the loop again at 5 s.
  const probingIds = entries
    .filter((e) => e.phase === 'probing' && e.itemId)
    .map((e) => e.itemId)
    .join(',')
  const prevProbing = useRef('')
  useEffect(() => {
    const before = new Set(prevProbing.current.split(',').filter(Boolean))
    prevProbing.current = probingIds
    if (probingIds.split(',').some((id) => id && !before.has(id))) schedulePoll(true)
  }, [probingIds, schedulePoll])

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (pollTimer.current) clearTimeout(pollTimer.current)
        pollTimer.current = null
      } else schedulePoll(true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [schedulePoll])

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
      } catch (e) {
        update(key, { phase: 'error', error: messageFor(e) })
      }
    },
    [ensureBatch, update],
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
    const ups = uploads.current
    return () => {
      mounted.current = false
      // Stop without terminating: the fingerprint lets the same file resume.
      for (const u of ups.values()) void u.abort(false)
    }
  }, [])

  const addFiles = (list: FileList | File[]) => {
    setTopError(null)
    const added: Entry[] = []
    for (const f of Array.from(list)) {
      const key = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      const c = precheck(f, { mp3: maxMp3UploadBytes, wav: maxWavUploadBytes })
      files.current.set(key, f)
      added.push({ key, fileName: f.name, size: f.size, phase: c.block ? 'blocked' : 'queued', progress: 0, warning: c.warn, error: c.block, edits: fieldsOf(undefined) })
      // Only an MP3 over the audio budget can still fit untouched thanks to
      // its tag (the 34.6–35 MiB band): read the tag size for the hint.
      if (f.size > AUDIO_PAYLOAD_BYTES && fileKind(f) === 'mp3')
        void f
          .slice(0, 10)
          .arrayBuffer()
          .then((b) => update(key, { id3Size: id3TagBytes(new Uint8Array(b)) }))
          .catch(() => {})
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
    // v0.4.1: a SoundCloud link still waiting, fetching or converting can be
    // cancelled (the server withdraws it and releases its reserve).
    if ((e.phase === 'ready' || (e.phase === 'probing' && e.source === 'soundcloud')) && e.itemId) {
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
  if (busy.some((e) => e.source === 'soundcloud'))
    blockers.push('Wait until every song has finished uploading, fetching and checking, or cancel the SoundCloud links you don’t want to wait for.')
  else if (busy.length) blockers.push('Wait until every file has finished uploading and checking.')
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

        {!soundcloudEnabled ? (
          <p className="rounded-xl border border-cream/10 p-3 text-sm text-cream/60" data-testid="sc-off">
            Adding songs from a SoundCloud link is switched off right now. Upload the MP3 or WAV instead.
          </p>
        ) : (
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
              One public track per link (no playlists or sets). We download it for you, convert it to an MP3 and fill in the title, artist and genre from SoundCloud; you can edit them. 30 s to{' '}
              {MAX_DURATION_MIN} min. Links are fetched one at a time, up to {FETCH_INFLIGHT_PER_USER} of yours at once
              {fetchesPerDay ? ` and ${fetchesPerDay} a day (a link that fails still counts)` : ''}.
            </p>
            {scError ? (
              <p className="text-sm text-rose-200" role="alert">
                {scError}
              </p>
            ) : null}
          </form>
        )}
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
                  if (e.itemId) update(e.key, { phase: 'probing', error: undefined })
                  else if (e.uploadUrl) void attach(e.key, e.uploadUrl)
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
