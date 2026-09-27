'use client'

// Comment thread for a batch (itemId = null) or one item. Staff comments are
// already removed server-side for non-reviewers (listComments applies
// canSeeComment); this component filters again so a staff comment can never
// render for a non-reviewer, and only reviewers get the staff option.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, messageFor } from './api'
import { when } from './format'
import { Notice, StaffBadge } from './ui'

export type UiComment = {
  id: number
  itemId: number | null
  body: string
  visibility: 'all' | 'staff'
  source: 'portal' | 'ticket'
  authorName: string | null
  createdAt: string
}

export function visibleComments(comments: UiComment[], isReviewer: boolean): UiComment[] {
  return comments.filter((c) => c.visibility === 'all' || (c.visibility === 'staff' && isReviewer))
}

export function CommentThread({
  batchId,
  itemId,
  comments,
  isReviewer,
  title,
}: {
  batchId: number
  itemId: number | null
  comments: UiComment[]
  isReviewer: boolean
  title: string
}) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [visibility, setVisibility] = useState<'all' | 'staff'>('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = visibleComments(comments, isReviewer)
  const fieldId = `comment-${itemId ?? 'batch'}-${batchId}`

  const post = async () => {
    setError(null)
    if (!body.trim()) {
      setError('Write a comment first.')
      return
    }
    setBusy(true)
    try {
      await api(`/api/batches/${batchId}/comments`, {
        json: { body: body.trim(), visibility: isReviewer ? visibility : 'all', ...(itemId ? { itemId } : {}) },
      })
      setBody('')
      setVisibility('all')
      router.refresh()
    } catch (e) {
      setError(messageFor(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3" aria-label={title}>
      <h3 className="text-sm font-semibold text-cream/80">{title}</h3>
      {list.length === 0 ? <p className="text-xs text-cream/50">No comments yet.</p> : null}
      <ul className="space-y-2">
        {list.map((c) => (
          <li
            key={c.id}
            data-comment-id={c.id}
            data-visibility={c.visibility}
            className={`rounded-xl border px-3 py-2 text-sm ${c.visibility === 'staff' ? 'border-violet-400/40 bg-violet-500/10' : 'border-cream/10 bg-cream/[0.03]'}`}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-cream/55">
              <span className="font-semibold text-cream/85">{c.authorName ?? 'Someone'}</span>
              {c.source === 'ticket' ? <span className="chip chip-neutral">via ticket</span> : null}
              {c.visibility === 'staff' ? <StaffBadge /> : null}
              <span>{when(c.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words">{c.body}</p>
          </li>
        ))}
      </ul>
      <div className="space-y-2">
        <label className="label" htmlFor={fieldId}>
          Add a comment
        </label>
        <textarea id={fieldId} className="input min-h-[70px]" maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex flex-wrap items-center gap-3">
          {isReviewer ? (
            <fieldset className="flex flex-wrap gap-3 text-xs" aria-label="Who can see this comment">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" name={`${fieldId}-vis`} className="checkbox size-4" checked={visibility === 'all'} onChange={() => setVisibility('all')} />
                Public (submitter + ticket)
              </label>
              <label className="flex cursor-pointer items-center gap-1.5" data-testid="staff-option">
                <input type="radio" name={`${fieldId}-vis`} className="checkbox size-4" checked={visibility === 'staff'} onChange={() => setVisibility('staff')} />
                Staff only (reviewers; never sent to the ticket)
              </label>
            </fieldset>
          ) : null}
          <button type="button" className="btn btn-secondary btn-sm ml-auto" onClick={() => void post()} disabled={busy}>
            {busy ? 'Posting…' : visibility === 'staff' && isReviewer ? 'Post staff note' : 'Post comment'}
          </button>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </section>
  )
}
