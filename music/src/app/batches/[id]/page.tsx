import Link from 'next/link'
import { AudioPreview } from '@/components/AudioPreview'
import { CommentThread, type UiComment } from '@/components/CommentThread'
import { convertedLabel, duration, playlistLabel, songName, when } from '@/components/format'
import { soundcloudLabel } from '@/lib/soundcloud'
import { probeErrorText } from '@/components/messages'
import { BatchStatusChip, ItemStatusChip, NewArtistBadge, Notice, PageTitle, TicketLink } from '@/components/ui'
import { WithdrawButton } from '@/components/WithdrawButton'
import { isReviewer } from '@/server/authz/predicates'
import { getDb } from '@/server/db/client'
import { parseId } from '@/server/http/route'
import { orNotFound, pageViewer } from '@/server/ui/page'
import { batchDetail } from '@/server/ui/queries'
import { uiSettings } from '@/server/ui/settings'
import { listComments } from '@/server/submissions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Batch' }

const PREVIEWABLE = new Set(['pending', 'approved', 'applying', 'verifying', 'live', 'denied', 'failed', 'draft'])

export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const viewer = await pageViewer('submit')
  const db = getDb()
  const { id: raw } = await params
  const sp = await searchParams
  const id = await orNotFound(async () => parseId(raw))
  const batch = await orNotFound(() => batchDetail(db, viewer, id))
  const [comments, s] = await Promise.all([
    listComments(db, viewer, id).then((cs) => cs.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })) as UiComment[]),
    uiSettings(db),
  ])
  const reviewer = isReviewer(viewer)
  const pendingCount = batch.items.filter((i) => i.status === 'pending').length

  return (
    <section className="space-y-6">
      <PageTitle
        title={`Batch #${batch.id}`}
        sub={
          <>
            {batch.submittedAt ? `Submitted ${when(batch.submittedAt)}` : `Started ${when(batch.createdAt)}`}
            {batch.ownerName && !batch.isOwn ? ` by ${batch.ownerName}` : ''}
          </>
        }
        actions={
          reviewer && pendingCount > 0 ? (
            <Link href={`/review?batch=${batch.id}`} className="btn btn-primary">
              Review {pendingCount} pending
            </Link>
          ) : batch.status === 'draft' && batch.isOwn ? (
            <Link href={`/submit?batch=${batch.id}`} className="btn btn-primary">
              Continue draft
            </Link>
          ) : null
        }
      />

      {sp.submitted === '1' ? <Notice tone="ok">Thanks! Your batch was submitted. A ticket is opening in Discord, and you can follow every song here.</Notice> : null}
      {sp.notes === 'failed' ? <Notice tone="warn">Your batch was submitted, but your notes could not be posted. Add them again as a comment below.</Notice> : null}

      <div className="card flex flex-wrap items-center gap-3">
        <BatchStatusChip status={batch.status} />
        <TicketLink ticket={batch.ticket} empty={batch.status === 'draft' ? 'Ticket opens when you submit' : 'Ticket is being opened…'} />
      </div>

      <ul className="space-y-4">
        {batch.items.map((it) => {
          const name = it.kind === 'new_artist' ? `New artist: ${it.newArtistName ?? it.artist ?? '?'}` : songName(it)
          return (
            <li key={it.id} id={`item-${it.id}`} className="card space-y-4" data-item-id={it.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-2 font-semibold">
                    {it.kind === 'new_artist' ? <NewArtistBadge /> : null}
                    <span className="break-words">{name}</span>
                  </h2>
                  <p className="text-xs text-cream/55">
                    {[it.album, it.genre, duration(it.durationS)].filter(Boolean).join(' · ')}
                    {it.source === 'soundcloud' ? ` · ${soundcloudLabel(it.fetchLicense)}` : ''}
                    {convertedLabel(it.inputFormat, it.transcodeKbps) ? ` · ${convertedLabel(it.inputFormat, it.transcodeKbps)}` : ''}
                  </p>
                  {it.playlistIds?.length && (reviewer || it.status !== 'pending') ? (
                    <p className="text-xs text-cream/55">Playlists: {it.playlistIds.map((p) => playlistLabel(s.playlistNames, p)).join(', ')}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ItemStatusChip status={it.status} />
                  {reviewer && it.selfApproved ? <span className="chip chip-pending">self-approved</span> : null}
                </div>
              </div>

              {it.status === 'denied' && it.denyReason ? (
                <Notice tone="error">
                  <span className="font-semibold">Reason:</span> {it.denyReason}
                </Notice>
              ) : null}
              {it.status === 'rejected' ? <Notice tone="error">{probeErrorText(it.probeError)}</Notice> : null}

              {it.kind === 'song' && PREVIEWABLE.has(it.status) ? <AudioPreview itemId={it.id} /> : null}

              <div className="flex flex-wrap gap-2">
                {batch.isOwn && it.status === 'pending' && batch.status !== 'draft' ? <WithdrawButton itemId={it.id} name={name} /> : null}
                {reviewer && it.status === 'pending' ? (
                  <Link href={`/review/items/${it.id}`} className="btn btn-primary btn-sm">
                    Review this item
                  </Link>
                ) : null}
              </div>

              <details className="rounded-xl border border-cream/10 p-3" open={comments.some((c) => c.itemId === it.id)}>
                <summary className="cursor-pointer text-sm font-medium text-cream/80 hover:text-cream">
                  Comments on this song ({comments.filter((c) => c.itemId === it.id && (c.visibility === 'all' || reviewer)).length})
                </summary>
                <div className="mt-3">
                  <CommentThread batchId={batch.id} itemId={it.id} comments={comments.filter((c) => c.itemId === it.id)} isReviewer={reviewer} title="Song comments" />
                </div>
              </details>
            </li>
          )
        })}
      </ul>

      <div className="card">
        <CommentThread batchId={batch.id} itemId={null} comments={comments.filter((c) => c.itemId === null)} isReviewer={reviewer} title="Batch conversation" />
      </div>
    </section>
  )
}
