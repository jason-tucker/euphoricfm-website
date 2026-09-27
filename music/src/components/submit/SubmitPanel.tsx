'use client'

// Rights attestation (required), notes to the managers, and the submit button
// with a confirmation step that shows the batch summary. The parent performs
// the actual requests in onSubmit; this component guarantees it is never
// called without the attestation checked.

import { useState } from 'react'
import { ConfirmDialog } from '../ConfirmDialog'
import { NewArtistBadge, Notice } from '../ui'

export type SummaryRow = { key: string; name: string; newArtist: boolean; edited: boolean; duplicate: boolean }

export function SubmitPanel({
  rights,
  rows,
  blockers,
  notes,
  onNotes,
  onSubmit,
}: {
  rights: { version: string; text: string }
  rows: SummaryRow[]
  // Reasons the batch cannot be submitted yet (still uploading, etc.).
  blockers: string[]
  notes: string
  onNotes: (v: string) => void
  onSubmit: (attest: { attest: true; version: string }) => Promise<string | null>
}) {
  const [attested, setAttested] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const attemptOpen = () => {
    setError(null)
    if (!attested) {
      setError('You must confirm the rights statement before submitting.')
      return
    }
    if (blockers.length) {
      setError(blockers[0]!)
      return
    }
    setOpen(true)
  }

  const confirm = async () => {
    if (!attested) return // belt and braces: never submit unattested
    setBusy(true)
    const err = await onSubmit({ attest: true, version: rights.version })
    setBusy(false)
    if (err) {
      setError(err)
      setOpen(false)
    }
  }

  return (
    <section className="card space-y-4" aria-labelledby="submit-h">
      <h2 id="submit-h" className="text-lg font-bold">
        Submit for review
      </h2>

      <div>
        <label className="label" htmlFor="notes">
          Notes to the managers (optional)
        </label>
        <textarea
          id="notes"
          className="input min-h-[80px]"
          maxLength={2000}
          value={notes}
          placeholder="Anything the managers should know: release date, clean/explicit, where you’d like it played…"
          onChange={(e) => onNotes(e.target.value)}
        />
        <p className="mt-1 text-xs text-cream/50">Posted to your submission ticket, visible to you and the managers.</p>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-cream/15 bg-cream/[0.03] p-3 hover:border-sunburst/40">
        <input
          type="checkbox"
          className="checkbox mt-0.5"
          checked={attested}
          onChange={(e) => {
            setAttested(e.target.checked)
            setError(null)
          }}
          aria-describedby="rights-version"
          required
        />
        <span className="text-sm">
          {rights.text}
          <span id="rights-version" className="mt-1 block text-xs text-cream/45">
            Rights statement version {rights.version}. Required.
          </span>
        </span>
      </label>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <button type="button" className="btn btn-primary w-full sm:w-auto" onClick={attemptOpen} disabled={!attested || rows.length === 0} aria-disabled={!attested}>
        Review and submit {rows.length} song{rows.length === 1 ? '' : 's'}
      </button>
      {!attested ? <p className="text-xs text-cream/50">Tick the rights statement to enable submitting.</p> : null}

      <ConfirmDialog open={open} title="Submit this batch?" confirmLabel="Submit" busy={busy} onConfirm={() => void confirm()} onCancel={() => setOpen(false)}>
        <p>
          {rows.length} song{rows.length === 1 ? '' : 's'} will be sent to the managers, and a ticket opens in Discord.
        </p>
        <ul className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-cream/10 p-2">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate">{r.name}</span>
              {r.newArtist ? <NewArtistBadge /> : null}
              {r.edited ? <span className="chip chip-neutral">edited</span> : null}
              {r.duplicate ? <span className="chip chip-pending">possible duplicate</span> : null}
            </li>
          ))}
        </ul>
        {notes.trim() ? (
          <p className="text-cream/70">
            Notes: <span className="whitespace-pre-wrap">{notes.trim()}</span>
          </p>
        ) : null}
        <p className="text-xs text-cream/60">You confirmed the rights statement (version {rights.version}).</p>
      </ConfirmDialog>
    </section>
  )
}
