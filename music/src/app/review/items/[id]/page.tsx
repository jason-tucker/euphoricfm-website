import Link from 'next/link'
import { AudioPreview } from '@/components/AudioPreview'
import { ItemArtControl } from '@/components/ItemArtControl'
import { Thumb } from '@/components/Thumb'
import { CommentThread, type UiComment } from '@/components/CommentThread'
import { convertedLabel, duration, playlistLabel, songName, when } from '@/components/format'
import { CANONICAL_URL_RE, soundcloudLabel } from '@/lib/soundcloud'
import { ReviewItemActions } from '@/components/review/ReviewItemActions'
import { ItemStatusChip, NewArtistBadge, Notice, PageTitle, TicketLink } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { parseId } from '@/server/http/route'
import { listComments } from '@/server/submissions'
import { findDuplicates, previewFolder } from '@/server/ui/library'
import { orNotFound, pageViewer } from '@/server/ui/page'
import { reviewItem, reviewQueue } from '@/server/ui/queries'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Review item' }

export default async function ReviewItemPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await pageViewer('review')
  const db = getDb()
  const { id: raw } = await params
  const id = await orNotFound(async () => parseId(raw))
  const r = await orNotFound(() => reviewItem(db, viewer, id))
  const it = r.item
  const [s, comments, dups, queue] = await Promise.all([
    uiSettings(db),
    listComments(db, viewer, r.batch.id).then((cs) => cs.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })) as UiComment[]),
    it.kind === 'song' && it.title && it.artist ? findDuplicates(db, viewer, it.title, it.artist, it.id) : Promise.resolve([]),
    reviewQueue(db, viewer),
  ])
  const folder = it.kind === 'new_artist' ? await previewFolder(db, it.newArtistName ?? it.artist ?? '') : null
  const nextPending = queue.flatMap((g) => g.items).find((x) => x.id !== it.id)
  const nextHref = nextPending ? `/review/items/${nextPending.id}` : '/review'
  const name = it.kind === 'new_artist' ? (it.newArtistName ?? it.artist ?? '?') : songName(it)
  const prefill = it.prefill ?? {}

  return (
    <section className="space-y-6">
      <p>
        <Link href="/review" className="link text-sm">
          ‹ Review queue
        </Link>
      </p>
      <PageTitle
        title={it.kind === 'new_artist' ? `New artist: ${name}` : name}
        sub={
          <>
            Submitted by {r.ownerName} in <Link className="link" href={`/batches/${r.batch.id}`}>batch #{r.batch.id}</Link>
            {r.batch.submittedAt ? ` · ${when(r.batch.submittedAt)}` : ''}
          </>
        }
      />

      <div className="card flex flex-wrap items-center gap-3">
        <ItemStatusChip status={it.status} />
        {it.kind === 'new_artist' ? <NewArtistBadge /> : null}
        {it.source === 'soundcloud' ? <span className="chip chip-pending">{soundcloudLabel(it.fetchLicense)}</span> : null}
        {it.source === 'soundcloud' && it.sourceUrl && CANONICAL_URL_RE.test(it.sourceUrl) ? (
          <a className="link text-sm" href={it.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" data-testid="source-url">
            {it.sourceUrl} ↗
          </a>
        ) : null}
        {it.isOwn ? <span className="chip chip-pending">your submission</span> : null}
        <TicketLink ticket={r.batch.ticket} />
      </div>

      {it.kind === 'song' ? (
        <div className="card space-y-3">
          {it.status === 'pending' ? (
            <ItemArtControl itemId={it.id} src={it.coverUrl} hasCustomArt={it.hasCustomArt} prompt="No cover art on this song. You can add or replace it before approving (optional)." />
          ) : (
            <Thumb src={it.coverUrl} alt="Album art" size="lg" />
          )}
          <AudioPreview itemId={it.id} hideCover />
          <p className="text-xs text-cream/60">
            {[duration(it.durationS), it.bitrate ? `${Math.round(it.bitrate / 1000)} kbps` : null, convertedLabel(it.inputFormat, it.transcodeKbps)].filter(Boolean).join(' · ')}
          </p>
          <details className="text-xs text-cream/60">
            <summary className="cursor-pointer hover:text-cream">{it.source === 'soundcloud' ? 'From SoundCloud' : 'Original file tags'}</summary>
            <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-1">
              {['title', 'artist', 'album', 'genre', 'year'].map((k) => (
                <div key={k} className="contents">
                  <dt className="capitalize">{k}</dt>
                  <dd className="break-words text-cream/80">{typeof prefill[k] === 'string' && prefill[k] ? prefill[k] : '—'}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      ) : null}

      {dups.length ? (
        <Notice tone="warn">
          <p className="font-semibold">Possible duplicate</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {dups.map((d, i) =>
              d.kind === 'library' ? (
                <li key={i}>
                  Already in the library: {d.artist} – {d.title}
                  {d.album ? ` (${d.album})` : ''}
                </li>
              ) : (
                <li key={i}>
                  Also submitted: <Link className="link" href={`/batches/${d.batchId}#item-${d.itemId}`}>{d.artist} – {d.title}</Link> ({d.status})
                </li>
              ),
            )}
          </ul>
        </Notice>
      ) : null}

      {it.status === 'pending' ? (
        <ReviewItemActions
          itemId={it.id}
          kind={it.kind}
          isSelf={it.isOwn}
          assignable={s.assignablePlaylistIds.map((pid) => ({ id: pid, label: playlistLabel(s.playlistNames, pid) }))}
          initialPlaylistIds={it.playlistIds?.length ? it.playlistIds : s.defaultPlaylistIds}
          initialFields={{ title: it.title ?? '', artist: it.artist ?? '', album: it.album ?? '', genre: it.genre ?? '' }}
          initialFolder={folder?.proposedFolder ?? it.newArtistName ?? ''}
          nextHref={nextHref}
        />
      ) : (
        <Notice tone="info">
          This item is no longer pending{it.decidedAt ? ` (decided ${when(it.decidedAt)}${it.decidedBy ? ` by ${it.decidedBy}` : ''})` : ''}.
          {it.selfApproved ? ' It was self-approved.' : ''}
          {it.denyReason ? ` Reason: ${it.denyReason}` : ''}
        </Notice>
      )}

      <div className="card">
        <CommentThread batchId={r.batch.id} itemId={it.id} comments={comments.filter((c) => c.itemId === it.id)} isReviewer title="Comments on this item" />
      </div>

      {r.siblings.length > 1 ? (
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold text-cream/80">Other items in this batch</h2>
          <ul className="space-y-2">
            {r.siblings
              .filter((x) => x.id !== it.id)
              .map((x) => (
                <li key={x.id}>
                  <Link href={`/review/items/${x.id}`} className="row-link text-sm">
                    <span className="min-w-0 flex-1 truncate">{x.kind === 'new_artist' ? `New artist: ${x.artist ?? ''}` : songName(x)}</span>
                    <ItemStatusChip status={x.status} />
                  </Link>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
