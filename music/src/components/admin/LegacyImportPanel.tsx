'use client'

// v0.3.3 "Archive the UNRELEASED folder" (managers). Step 1: a dry run (the
// worker lists the folder read-only) shows every planned move, source →
// destination, and the playlists each file leaves. Step 2: confirm that
// exact plan; the worker then archives one file per scan window (~5 min).

import { useEffect, useState } from 'react'
import { legacyImportDryRun, legacyImportRun } from '@/lib/api/admin'
import type { LegacyPlan, PlanState } from '@/server/requests/legacy-import'
import { messageFor } from '../api'
import { ConfirmDialog } from '../ConfirmDialog'
import { playlistLabel } from '../format'
import { useJson } from '../hooks'
import { Notice } from '../ui'

type State = { plan: PlanState | null; jobsLive: number; archiveCounts: Record<string, number> }

const ACTION: Record<string, string> = {
  archive: 'Archive',
  refuse_events: 'Refused: in an Events playlist',
  skip_archived: 'Skipped: already archived',
  skip_queued: 'Skipped: already queued',
}

export function LegacyImportPanel() {
  const [tick, setTick] = useState(0)
  const { data, error: loadError } = useJson<State>(`/api/admin/legacy-import?t=${tick}`)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const plan = data?.plan ?? null
  const waiting = plan?.status === 'queued' || (data?.jobsLive ?? 0) > 0
  // Poll while the worker is listing the folder or importing.
  useEffect(() => {
    if (!waiting) return
    const t = setTimeout(() => setTick((n) => n + 1), 3000)
    return () => clearTimeout(t)
  }, [waiting, tick])

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      setMsg({ tone: 'ok', text: ok })
      setTick((n) => n + 1)
    } catch (e) {
      setMsg({ tone: 'error', text: messageFor(e) })
    } finally {
      setBusy(false)
    }
  }

  const ready = plan?.status === 'ready' ? plan : null
  const shown: LegacyPlan | null = plan && (plan.status === 'ready' || plan.status === 'confirmed') ? plan.plan : null
  const toGo = shown ? shown.files.filter((f) => f.action === 'archive' || f.action === 'refuse_events').length : 0
  const counts = data?.archiveCounts ?? {}

  return (
    <div className="space-y-3 text-sm" data-testid="legacy-import">
      <p className="text-cream/70">
        Moves every song in the UNRELEASED folder into the archive, where they show as <strong>Unreleased</strong> under Archived songs (staff, the uploader, or a member you link). A song in a playlist leaves rotation. Nothing is deleted or re-tagged, and each one can be released into an artist folder later.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || plan?.status === 'queued'} onClick={() => void run(legacyImportDryRun, 'Dry run queued: the list appears here in a moment. Nothing is moved yet.')}>
          Archive the UNRELEASED folder: dry run
        </button>
        {ready ? (
          <button type="button" className="btn btn-danger btn-sm" disabled={busy || toGo === 0 || (data?.jobsLive ?? 0) > 0} onClick={() => setConfirm(true)}>
            Confirm: archive {toGo} file{toGo === 1 ? '' : 's'}…
          </button>
        ) : null}
      </div>
      {loadError ? <Notice tone="error">Could not load the import status.</Notice> : null}
      {plan?.status === 'queued' ? <Notice tone="info">Listing the folder (read-only)…</Notice> : null}
      {plan?.status === 'failed' ? <Notice tone="error">The dry run failed: {plan.error}. Try again.</Notice> : null}
      {plan?.status === 'confirmed' ? (
        <Notice tone="info">
          Confirmed: {plan.queued} file(s) queued, one per scan window. {data?.jobsLive ?? 0} still to go. Archived so far: {counts.archived ?? 0}
          {counts.archiving ? ` (${counts.archiving} in progress)` : ''}.
        </Notice>
      ) : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {shown ? (
        <div className="space-y-2">
          <p className="text-xs text-cream/60">
            {plan?.status === 'ready' ? 'Dry run' : 'Confirmed plan'}: {shown.files.length} file(s) in {shown.folder}. {shown.summary.archive} to archive ({shown.summary.offAir} leave rotation), {shown.summary.refused} refused, {shown.summary.skipped} skipped
            {shown.summary.others ? `, ${shown.summary.others} other entr${shown.summary.others === 1 ? 'y' : 'ies'} not moved` : ''}.
          </p>
          <div className="max-h-96 overflow-auto rounded-xl border border-cream/10">
            <table className="w-full text-left text-xs">
              <thead className="text-cream/55">
                <tr>
                  <th className="p-2">Song</th>
                  <th className="p-2">From → to</th>
                  <th className="p-2">Playlists cleared</th>
                  <th className="p-2">Plan</th>
                </tr>
              </thead>
              <tbody>
                {shown.files.map((f) => (
                  <tr key={f.mediaId} className="border-t border-cream/10 align-top" data-media-id={f.mediaId}>
                    <td className="p-2">
                      {f.artist ?? '?'} — {f.title ?? '?'}
                    </td>
                    <td className="break-all p-2 font-mono">
                      {f.path}
                      <br />→ {f.dest}
                    </td>
                    <td className="p-2">{f.playlistIds.length ? f.playlistIds.map((id) => playlistLabel(shown.playlistNames, id)).join(', ') : 'none'}</td>
                    <td className="p-2">{ACTION[f.action] ?? f.action}{f.action === 'refuse_events' ? ` (${f.foreignPlaylistIds.join(', ')})` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.others.length ? <p className="text-xs text-cream/55">Not moved: {shown.others.map((o) => `${o.path} (${o.reason})`).join('; ')}</p> : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title="Archive the UNRELEASED folder?"
        confirmLabel={`Archive ${toGo} file${toGo === 1 ? '' : 's'}`}
        confirmClass="btn-danger"
        busy={busy}
        onConfirm={() => {
          setConfirm(false)
          if (ready) void run(() => legacyImportRun(ready.id), `Queued ${toGo} file(s). The worker archives one per scan window (about ${Math.ceil(toGo * 5)} min in all).`)
        }}
        onCancel={() => setConfirm(false)}
      >
        <p>Exactly the files in the dry run above are moved into the archive, one every ~5 minutes. Songs in a playlist leave rotation (their memberships are kept in a snapshot). A song in an Events playlist is refused and alerted.</p>
      </ConfirmDialog>
    </div>
  )
}
