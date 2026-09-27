import { when } from '@/components/format'
import { ArtistDecision } from '@/components/requests/ArtistDecision'
import { RequestDecision } from '@/components/requests/RequestDecision'
import { ReviewTabs } from '@/components/review/ReviewTabs'
import { ArtUploadPreview } from '@/components/ArtUploadPreview'
import { Thumb } from '@/components/Thumb'
import { PageTitle, TicketLink } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { artistsAwaitingApproval, pendingRequests } from '@/server/ui/browse'
import { pageViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Requests to review' }

const KEYS = ['title', 'artist', 'album', 'genre'] as const

export default async function ReviewRequestsPage() {
  const viewer = await pageViewer('review')
  const db = getDb()
  const [rows, waiting] = await Promise.all([pendingRequests(db, viewer), artistsAwaitingApproval(db, viewer)])
  return (
    <section>
      <PageTitle title="Review" sub={`${rows.length} pending edit/removal request${rows.length === 1 ? '' : 's'}, oldest first.`} />
      <ReviewTabs active="requests" />
      {waiting.length ? (
        <section className="mb-6 space-y-3" aria-labelledby="waiting-h">
          <h2 id="waiting-h" className="text-lg font-bold">
            New artists waiting for approval
          </h2>
          {waiting.map((a) => (
            <div key={a.artistId} className="card space-y-2 border-gold/40" data-waiting-artist={a.artistId}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="chip chip-new">NEW ARTIST</span>
                <span className="font-semibold">{a.name}</span>
                <span className="text-xs text-cream/60">folder: {a.folder}</span>
              </p>
              <ul className="list-disc pl-5 text-xs text-cream/70">
                {a.requests.map((r) => (
                  <li key={r.id}>
                    Edit request #{r.id}: {r.targetPath.replace(/^.*Music\/Artists\//, '')}
                  </li>
                ))}
              </ul>
              <ArtistDecision artistId={a.artistId} name={a.name} folder={a.folder} />
            </div>
          ))}
        </section>
      ) : null}
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
              <div className="flex flex-wrap items-center gap-3">
                <Thumb src={r.currentArtUrl} alt="Current album art" size="md" />
                {r.proposedArtId ? (
                  <>
                    <span aria-hidden="true" className="text-cream/50">→</span>
                    <ArtUploadPreview artId={r.proposedArtId} alt="Proposed album art" />
                    <span className="chip chip-pending">new album art proposed</span>
                  </>
                ) : null}
                <p className="min-w-0 flex-1 break-all text-xs text-cream/60">{r.targetPath.replace(/^.*Music\/Artists\//, '')}</p>
              </div>
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
