import { when } from '@/components/format'
import { RequestDecision } from '@/components/requests/RequestDecision'
import { ReviewTabs } from '@/components/review/ReviewTabs'
import { PageTitle, TicketLink } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { pendingRequests } from '@/server/ui/browse'
import { pageViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Requests to review' }

const KEYS = ['title', 'artist', 'album', 'genre'] as const

export default async function ReviewRequestsPage() {
  const viewer = await pageViewer('review')
  const rows = await pendingRequests(getDb(), viewer)
  return (
    <section>
      <PageTitle title="Review" sub={`${rows.length} pending edit/removal request${rows.length === 1 ? '' : 's'}, oldest first.`} />
      <ReviewTabs active="requests" />
      {rows.length === 0 ? (
        <p className="card text-center text-cream/70">No requests waiting.</p>
      ) : (
        <ul className="space-y-4">
          {rows.map((r) => (
            <li key={r.id} className="card space-y-3" data-request-id={r.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">
                  {r.kind === 'edit' ? 'Edit' : 'Removal'} request #{r.id}{' '}
                  <span className="text-sm font-normal text-cream/60">
                    by {r.ownerName} · {when(r.createdAt)}
                  </span>
                </h2>
                <TicketLink ticket={r.ticket} />
              </div>
              <p className="break-all text-xs text-cream/60">{r.targetPath.replace(/^Music\/Artists\//, '')}</p>
              {r.kind === 'edit' && r.proposed ? (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs text-cream/50">
                      <th className="py-1 pr-3">Field</th>
                      <th className="py-1 pr-3">Now</th>
                      <th className="py-1">Proposed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {KEYS.filter((k) => k in (r.proposed ?? {})).map((k) => (
                      <tr key={k} className="border-t border-cream/10">
                        <td className="py-1 pr-3 capitalize">{k}</td>
                        <td className="py-1 pr-3 text-cream/60">{r.current?.[k] ?? '—'}</td>
                        <td className="py-1 font-medium text-sunburst">{r.proposed?.[k]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {r.kind === 'removal' && r.current ? (
                <p className="text-sm">
                  Remove “{r.current.artist} – {r.current.title}” (archive; restorable)
                </p>
              ) : null}
              {!r.current ? <p className="text-xs text-rose-200">This song is no longer in the library cache.</p> : null}
              {r.reason ? <p className="whitespace-pre-wrap text-sm text-cream/80">Reason: {r.reason}</p> : null}
              <RequestDecision id={r.id} kind={r.kind} isSelf={r.isOwn} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
