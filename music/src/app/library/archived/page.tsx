import Link from 'next/link'
import { LegacyImportPanel } from '@/components/admin/LegacyImportPanel'
import { playlistLabel, when } from '@/components/format'
import { LinkMemberControl } from '@/components/requests/LinkMemberControl'
import { ReleaseButton } from '@/components/requests/ReleaseButton'
import { ResolveArchiveButton } from '@/components/requests/ResolveArchiveButton'
import { RestoreButton } from '@/components/requests/RestoreButton'
import { Chip, PageTitle } from '@/components/ui'
import { isReviewer } from '@/server/authz/predicates'
import { getDb } from '@/server/db/client'
import { mainArtist } from '@/server/requests/common'
import { archivedSongs } from '@/server/ui/browse'
import { pageViewer } from '@/server/ui/page'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Archived songs' }

// Staff (review or manage) see every archived song; a member sees the ones
// they uploaded through the portal or a manager linked them to, read-only
// (v0.3.6). Restore, Release, Resolve and member links are manager-only,
// and so is "Archive the UNRELEASED folder" (here as well as on /admin, so
// a manager who is not an admin reaches it too). Newest first, paged.
export default async function ArchivedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await pageViewer('submit')
  const sp = await searchParams
  const want = typeof sp.page === 'string' && /^\d{1,4}$/.test(sp.page) ? Number(sp.page) : 1
  const db = getDb()
  const staff = isReviewer(viewer)
  const manage = viewer.perms.has('manage')
  const [r, s] = await Promise.all([archivedSongs(db, viewer, { page: want }), manage ? uiSettings(db) : null])
  const rows = r.rows
  const href = (p: number) => `/library/archived?${new URLSearchParams({ page: String(p) })}`
  const assignable = s ? s.assignablePlaylistIds.map((id) => ({ id, label: playlistLabel(s.playlistNames, id) })) : []
  return (
    <section>
      <p className="mb-2">
        <Link href="/library" className="link text-sm">
          ‹ Library
        </Link>
      </p>
      <PageTitle
        title="Archived songs"
        sub={
          staff
            ? 'Songs taken out of the library (Removed) and the songs from the old UNRELEASED folder (Unreleased). Restoring a removed song puts it back in its folder and playlists; releasing an unreleased song puts it in an artist folder you choose.'
            : 'Your songs that are archived: songs you uploaded here, or that a manager linked to you. Ask a manager if one should come back.'
        }
      />
      {r.pages > 1 ? (
        <p className="mb-3 text-sm text-cream/60" data-testid="archived-count">
          {r.total} archived songs, newest first · page {r.page} of {r.pages}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="card text-center text-cream/70">{staff ? 'Nothing is archived.' : 'None of your songs are archived.'}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => {
            const name = a.title ? `${a.artist ?? '?'} — ${a.title}` : a.fileName
            const st = a.staff
            return (
              <li key={a.id} className="card flex flex-wrap items-start justify-between gap-3 py-3" data-archive-id={a.id} data-label={a.label}>
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Chip tone={a.label === 'Unreleased' ? 'pending' : 'muted'}>{a.label}</Chip>
                    <span className="truncate text-sm font-medium">{name}</span>
                  </p>
                  <p className="truncate text-xs text-cream/60">
                    Archived {when(a.archivedAt)}
                    {a.reason ? ` · ${a.reason}` : a.label === 'Unreleased' ? ' · from the UNRELEASED folder' : staff ? '' : ' · Removed from the station'}
                  </p>
                  {st ? (
                    <p className="truncate text-xs text-cream/50">
                      {st.folder ? `Was in Music/Artists/${st.folder}` : `Was ${st.originalPath}`} · media #{st.mediaId}
                      {st.requestId ? ` · request #${st.requestId}` : ''}
                      {st.uploader ? ` · uploaded by ${st.uploader.name ?? 'a member'}` : ''}
                    </p>
                  ) : null}
                  {st && (st.status === 'archiving' || st.status === 'restoring') ? (
                    <p className="text-xs text-sunburst">
                      {st.status === 'archiving' ? 'Archiving stopped part way.' : a.label === 'Unreleased' ? 'Releasing stopped part way.' : 'Restoring stopped part way.'} The worker settles it on its own; Resolve does it now.
                    </p>
                  ) : null}
                  {st && manage ? <LinkMemberControl archiveId={a.id} linked={st.linkedUser} /> : st?.linkedUser ? <p className="text-xs text-cream/60">Visible to member: {st.linkedUser.name ?? st.linkedUser.discordId}</p> : null}
                </div>
                {st && manage ? (
                  <span className="inline-flex items-start gap-2">
                    {st.status === 'archiving' || st.status === 'restoring' ? <ResolveArchiveButton archiveId={a.id} name={name} status={st.status} /> : null}
                    {a.label === 'Unreleased' ? (
                      st.status === 'archived' ? (
                        <ReleaseButton
                          archiveId={a.id}
                          name={name}
                          defaultArtist={mainArtist(a.artist)}
                          assignable={assignable}
                          hintLabels={st.playlistIds.map((id) => playlistLabel(s!.playlistNames, id))}
                        />
                      ) : null
                    ) : (
                      <RestoreButton archiveId={a.id} name={name} />
                    )}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {r.pages > 1 ? (
        <nav aria-label="Pages" className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {r.page > 1 ? (
            <Link href={href(r.page - 1)} className="btn btn-secondary btn-sm">
              ‹ Newer
            </Link>
          ) : null}
          <span className="text-sm text-cream/60">
            Page {r.page} of {r.pages}
          </span>
          {r.page < r.pages ? (
            <Link href={href(r.page + 1)} className="btn btn-secondary btn-sm">
              Older ›
            </Link>
          ) : null}
        </nav>
      ) : null}
      {manage ? (
        <section className="card mt-6 space-y-3" aria-labelledby="legacy-h">
          <h2 id="legacy-h" className="text-lg font-bold">
            Archive the UNRELEASED folder
          </h2>
          <LegacyImportPanel />
        </section>
      ) : null}
    </section>
  )
}
