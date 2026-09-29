import Link from 'next/link'
import { duration } from '@/components/format'
import { openGraph } from '@/components/og'
import { ActionIcon, parseIntent, requestHref, type RequestIntent } from '@/components/HomeActions'
import { Thumb } from '@/components/Thumb'
import { PageTitle } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { browseLibrary, PAGE_SIZE } from '@/server/ui/browse'
import { pageViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Library',
  description: 'Every song on EuphoricFM: find one to fix its info or cover, or to ask for its removal.',
  openGraph: openGraph('Library · EuphoricFM Music Portal', 'Every song on EuphoricFM.', '/library'),
}

const BANNER: Record<RequestIntent, { title: string; text: string; button: string }> = {
  edit: {
    title: 'Pick the song you want to fix',
    text: 'Search for it below, then press “Suggest edit”. You can propose a new title, artist, album, genre or cover art.',
    button: 'Suggest edit',
  },
  remove: {
    title: 'Pick the song you want removed',
    text: 'Search for it below, then press “Request removal” and tell the managers why it should come off the station.',
    button: 'Request removal',
  },
}

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await pageViewer('submit')
  const sp = await searchParams
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 100) : ''
  const page = typeof sp.page === 'string' && /^\d{1,4}$/.test(sp.page) ? Number(sp.page) : 1
  // Members without the request permission browse only (no request buttons).
  const canRequest = viewer.perms.has('request')
  const intent = canRequest ? parseIntent(sp.intent) : null
  const r = await browseLibrary(getDb(), viewer, { q: q || undefined, page })
  const pages = Math.max(1, Math.ceil(r.total / PAGE_SIZE))
  const href = (p: number) => `/library?${new URLSearchParams({ ...(intent ? { intent } : {}), ...(q ? { q } : {}), page: String(p) })}`
  const banner = intent ? BANNER[intent] : null
  return (
    <section>
      <PageTitle
        title="Library"
        sub={canRequest ? 'Songs on EuphoricFM. Find one to suggest an edit or ask for its removal.' : 'Songs on EuphoricFM.'}
        actions={
          <Link href="/library/archived" className="btn btn-secondary">
            {viewer.perms.has('review') ? 'Archived songs' : 'My archived songs'}
          </Link>
        }
      />
      {banner ? (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-sunburst/50 bg-sunburst/10 p-4" data-testid="intent-banner" data-intent={intent}>
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-sunburst">{banner.title}</h2>
            <p className="mt-1 text-sm text-cream/80">{banner.text}</p>
          </div>
          <Link href={q ? `/library?${new URLSearchParams({ q })}` : '/library'} className="link shrink-0 text-sm">
            Just browse
          </Link>
        </div>
      ) : null}
      <form method="get" className="card mb-5 flex flex-wrap items-end gap-3" role="search">
        {intent ? <input type="hidden" name="intent" value={intent} /> : null}
        <div className="min-w-[12rem] flex-1">
          <label className="label" htmlFor="lib-q">
            Search title, artist or album
          </label>
          <input id="lib-q" name="q" className="input" defaultValue={q} />
        </div>
        <button type="submit" className="btn btn-secondary">
          Search
        </button>
        {q ? (
          <Link href={intent ? `/library?intent=${intent}` : '/library'} className="btn btn-secondary">
            Clear
          </Link>
        ) : null}
      </form>
      <p className="mb-3 text-sm text-cream/60">
        {r.total} song{r.total === 1 ? '' : 's'}
        {q ? ` matching “${q}”` : ''}
      </p>
      {r.songs.length === 0 ? (
        <p className="card text-center text-cream/70">No songs found.</p>
      ) : (
        <ul className="space-y-2">
          {r.songs.map((s) => {
            const name = s.title ?? s.fileName
            return (
              <li key={s.mediaId} className="flex items-center gap-2" data-media-id={s.mediaId}>
                <Link href={intent ? requestHref(s.mediaId, intent) : `/library/${s.mediaId}`} className="row-link min-w-0 flex-1">
                  <Thumb src={s.artUrl} alt="" size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{name}</span>
                    <span className="block truncate text-xs text-cream/60">{[s.artist, s.album].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="shrink-0 text-xs text-cream/50 max-sm:hidden">{duration(s.lengthS)}</span>
                </Link>
                {!canRequest ? null : intent ? (
                  <Link
                    href={requestHref(s.mediaId, intent)}
                    className={`btn btn-sm shrink-0 max-sm:size-10 max-sm:p-0 ${intent === 'remove' ? 'btn-danger' : 'btn-primary'}`}
                    aria-label={`${BANNER[intent].button}: ${name}`}
                    data-request-link={intent}
                  >
                    <ActionIcon name={intent} className="size-4 shrink-0" />
                    <span className="max-sm:sr-only">{BANNER[intent].button}</span>
                  </Link>
                ) : (
                  <span className="flex shrink-0 gap-2">
                    <Link href={requestHref(s.mediaId, 'edit')} className="btn btn-secondary btn-sm max-sm:size-10 max-sm:p-0" aria-label={`Suggest edit: ${name}`} data-request-link="edit">
                      <ActionIcon name="edit" className="size-4 shrink-0" />
                      <span className="max-sm:sr-only">Suggest edit</span>
                    </Link>
                    <Link href={requestHref(s.mediaId, 'remove')} className="btn btn-secondary btn-sm max-sm:size-10 max-sm:p-0" aria-label={`Request removal: ${name}`} data-request-link="remove">
                      <ActionIcon name="remove" className="size-4 shrink-0" />
                      <span className="max-sm:sr-only">Request removal</span>
                    </Link>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {pages > 1 ? (
        <nav aria-label="Pages" className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {r.page > 1 ? (
            <Link href={href(r.page - 1)} className="btn btn-secondary btn-sm">
              ‹ Previous
            </Link>
          ) : null}
          <span className="text-sm text-cream/60">
            Page {r.page} of {pages}
          </span>
          {r.page < pages ? (
            <Link href={href(r.page + 1)} className="btn btn-secondary btn-sm">
              Next ›
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  )
}
