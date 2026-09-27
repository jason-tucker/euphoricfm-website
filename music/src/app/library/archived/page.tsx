import Link from 'next/link'
import { when } from '@/components/format'
import { ResolveArchiveButton } from '@/components/requests/ResolveArchiveButton'
import { RestoreButton } from '@/components/requests/RestoreButton'
import { PageTitle } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { archivedSongs } from '@/server/ui/browse'
import { pageViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Archived songs' }

export default async function ArchivedPage() {
  const viewer = await pageViewer('manage')
  const rows = await archivedSongs(getDb(), viewer)
  return (
    <section>
      <p className="mb-2">
        <Link href="/library" className="link text-sm">
          ‹ Library
        </Link>
      </p>
      <PageTitle title="Archived songs" sub="Songs taken out of the library. Restoring puts a song back in its original folder and playlists." />
      {rows.length === 0 ? (
        <p className="card text-center text-cream/70">Nothing is archived.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.id} className="card flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{a.fileName}</p>
                <p className="truncate text-xs text-cream/60">
                  Was in Music/Artists/{a.folder} · archived {when(a.archivedAt)}
                  {a.requestId ? ` · request #${a.requestId}` : ''}
                </p>
                {a.status === 'archiving' || a.status === 'restoring' ? (
                  <p className="text-xs text-sunburst">
                    {a.status === 'archiving' ? 'Archiving stopped part way.' : 'Restoring stopped part way.'} The worker settles it on its own; Resolve does it now.
                  </p>
                ) : null}
              </div>
              <span className="inline-flex items-start gap-2">
                {a.status === 'archiving' || a.status === 'restoring' ? <ResolveArchiveButton archiveId={a.id} name={a.fileName} status={a.status} /> : null}
                <RestoreButton archiveId={a.id} name={a.fileName} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
