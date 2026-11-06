import Link from 'next/link'
import { songName } from '@/components/format'
import { LocalTime } from '@/components/LocalTime'
import { ActionBar, summaryText } from '@/components/HomeActions'
import { probeErrorText } from '@/components/messages'
import { Thumb } from '@/components/Thumb'
import { RequestWithdrawButton } from '@/components/requests/RequestWithdrawButton'
import { BatchStatusChip, ItemStatusChip, NewArtistBadge, PageTitle, RequestStatusChip, TicketLink } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { pageViewer } from '@/server/ui/page'
import { listOwnBatches, listOwnRequests, memberSummary } from '@/server/ui/queries'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'My music', description: 'Your songs and requests on the EuphoricFM Music Portal.' }

// The member's OWN batches, items and requests only (every query filters on
// the viewer's user id).
export default async function Dashboard() {
  const viewer = await pageViewer('submit')
  const db = getDb()
  const [batches, requests, summary] = await Promise.all([listOwnBatches(db, viewer), listOwnRequests(db, viewer), memberSummary(db, viewer)])
  const canRequest = viewer.perms.has('request')
  return (
    <section>
      <PageTitle title="My music" sub="Everything you have submitted, and where each song is." />
      <div className="card mb-6 space-y-3">
        <ActionBar perms={viewer.perms} />
        <p className="text-sm text-cream/70" data-testid="dashboard-summary">
          {summaryText(summary)}
          {summary.openRequests > 0 ? (
            <>
              {' · '}
              <a href="#requests" className="link">
                see requests
              </a>
            </>
          ) : null}
        </p>
      </div>

      {batches.length === 0 ? (
        <div className="card text-center">
          <p className="text-cream/80">You haven&apos;t submitted any music yet.</p>
          <Link href="/submit" className="btn btn-primary mt-4">
            Submit your first songs
          </Link>
        </div>
      ) : (
        <ul className="space-y-4" data-testid="own-batches">
          {batches.map((b) => (
            <li key={b.id} className="card" data-batch-id={b.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">Batch #{b.id}</h2>
                  <BatchStatusChip status={b.status} />
                  <span className="text-xs text-cream/55">
                    {b.submittedAt ? 'Submitted ' : 'Started '}
                    <LocalTime iso={b.submittedAt ?? b.createdAt} />
                  </span>
                </div>
                <TicketLink ticket={b.ticket} empty={b.status === 'draft' ? 'Ticket opens when you submit' : 'Ticket is being opened…'} />
              </div>
              <ul className="mt-3 space-y-2" data-testid="own-items">
                {b.items.length === 0 ? <li className="text-sm text-cream/50">No files in this batch.</li> : null}
                {b.items.map((it) => (
                  <li key={it.id} data-item-id={it.id} className="rounded-xl border border-cream/10 bg-cream/[0.02] px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {it.kind === 'song' ? <Thumb src={it.coverUrl} alt="" size="xs" /> : null}
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {it.kind === 'new_artist' ? (
                          <>
                            <NewArtistBadge /> <span className="ml-1">{it.newArtistName ?? it.artist}</span>
                          </>
                        ) : (
                          songName(it)
                        )}
                      </span>
                      <ItemStatusChip status={it.status} source={it.source} fetchStage={it.fetchStage} />
                    </div>
                    {it.status === 'denied' && it.denyReason ? <p className="mt-1 text-xs text-rose-200">Reason: {it.denyReason}</p> : null}
                    {it.status === 'rejected' ? <p className="mt-1 text-xs text-rose-200">{probeErrorText(it.probeError)}</p> : null}
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                {b.status === 'draft' ? (
                  <Link href={`/submit?batch=${b.id}`} className="row-link text-sm font-medium">
                    Continue this draft
                  </Link>
                ) : (
                  <Link href={`/batches/${b.id}`} className="row-link text-sm font-medium">
                    View details, preview and comments
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-10 scroll-mt-4" id="requests" aria-labelledby="requests-h">
        <div className="mb-3">
          <h2 id="requests-h" className="mb-1 text-lg font-bold">
            Your edit and removal requests
          </h2>
          <p className="text-sm text-cream/60">Changes you asked for on songs already on the station. Each one has its own ticket in Discord.</p>
        </div>
        {requests.length === 0 ? (
          <div className="card space-y-3" data-testid="no-requests">
            <p className="text-sm text-cream/70">
              You haven&apos;t filed any requests. To fix a song&apos;s title, artist, album or cover, or to ask for a song to come off the station, find it in the library.
            </p>
            {canRequest ? (
              <div className="flex flex-wrap gap-2">
                <Link href="/library?intent=edit" className="btn btn-secondary btn-sm">
                  Fix a song&apos;s info
                </Link>
                <Link href="/library?intent=remove" className="btn btn-secondary btn-sm">
                  Ask to remove a song
                </Link>
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="space-y-2" data-testid="own-requests">
            {requests.map((r) => (
              <li key={r.id} className="card flex flex-wrap items-center justify-between gap-2 py-3">
                <Thumb src={r.artUrl} alt="" size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {!r.onLibrary ? (
                      <>
                        {r.kind === 'edit' ? 'Edit' : 'Removal'} request #{r.id}
                      </>
                    ) : (
                      <Link href={`/library/${r.mediaId}`} className="link">
                        {r.kind === 'edit' ? 'Edit' : 'Removal'} request #{r.id}
                      </Link>
                    )}{' '}
                    <span className="text-xs font-normal text-cream/55">
                      · <LocalTime iso={r.createdAt} />
                    </span>
                  </p>
                  <p className="truncate text-xs text-cream/60">{r.targetPath.replace(/^Music\/Artists\//, '')}</p>
                  {r.proposed ? (
                    <p className="text-xs text-cream/60">
                      Proposed:{' '}
                      {Object.entries(r.proposed)
                        .map(([k, v]) => (k === 'artId' ? 'new album art' : `${k}: ${String(v)}`))
                        .join(', ')}
                    </p>
                  ) : null}
                  {r.awaitingArtist ? <p className="text-xs text-gold">Approved; waiting for managers to approve the new artist.</p> : null}
                  {r.status === 'denied' && r.denyReason ? <p className="text-xs text-rose-200">Reason: {r.denyReason}</p> : null}
                  {r.status === 'failed' && r.error ? <p className="text-xs text-rose-200">It could not be applied ({r.error}). The managers have been told.</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <RequestStatusChip status={r.status} />
                  <TicketLink ticket={r.ticket} empty="Ticket is being opened…" />
                  {r.status === 'pending' ? <RequestWithdrawButton id={r.id} /> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
