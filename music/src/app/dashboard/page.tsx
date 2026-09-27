import Link from 'next/link'
import { songName, when } from '@/components/format'
import { probeErrorText } from '@/components/messages'
import { BatchStatusChip, ItemStatusChip, NewArtistBadge, PageTitle, RequestStatusChip, TicketLink } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { pageViewer } from '@/server/ui/page'
import { listOwnBatches, listOwnRequests } from '@/server/ui/queries'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'My music' }

// The member's OWN batches, items and requests only (every query filters on
// the viewer's user id).
export default async function Dashboard() {
  const viewer = await pageViewer('submit')
  const db = getDb()
  const [batches, requests] = await Promise.all([listOwnBatches(db, viewer), listOwnRequests(db, viewer)])
  return (
    <section>
      <PageTitle
        title="My music"
        sub="Everything you have submitted, and where each song is."
        actions={
          <Link href="/submit" className="btn btn-primary">
            + Submit songs
          </Link>
        }
      />

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
                  <span className="text-xs text-cream/50">{b.submittedAt ? `Submitted ${when(b.submittedAt)}` : `Started ${when(b.createdAt)}`}</span>
                </div>
                <TicketLink ticket={b.ticket} empty={b.status === 'draft' ? 'Ticket opens when you submit' : 'Ticket is being opened…'} />
              </div>
              <ul className="mt-3 space-y-2" data-testid="own-items">
                {b.items.length === 0 ? <li className="text-sm text-cream/50">No files in this batch.</li> : null}
                {b.items.map((it) => (
                  <li key={it.id} data-item-id={it.id} className="rounded-xl border border-cream/10 bg-cream/[0.02] px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm">
                        {it.kind === 'new_artist' ? (
                          <>
                            <NewArtistBadge /> <span className="ml-1">{it.newArtistName ?? it.artist}</span>
                          </>
                        ) : (
                          songName(it)
                        )}
                      </span>
                      <ItemStatusChip status={it.status} />
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

      <section className="mt-10">
        <h2 className="mb-1 text-lg font-bold">Edit and removal requests</h2>
        <p className="mb-3 text-sm text-cream/60">Requests you have filed about songs already in the library.</p>
        {requests.length === 0 ? (
          <p className="card text-sm text-cream/60">You haven&apos;t filed any requests.</p>
        ) : (
          <ul className="space-y-2" data-testid="own-requests">
            {requests.map((r) => (
              <li key={r.id} className="card flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {r.kind === 'edit' ? 'Edit' : 'Removal'} request #{r.id}
                  </p>
                  <p className="truncate text-xs text-cream/60">{r.targetPath.replace(/^Music\/Artists\//, '')}</p>
                  {r.proposed ? (
                    <p className="text-xs text-cream/60">
                      Proposed:{' '}
                      {Object.entries(r.proposed)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ')}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <RequestStatusChip status={r.status} />
                  <TicketLink ticket={r.ticket} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
