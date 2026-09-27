import Link from 'next/link'
import { duration } from '@/components/format'
import { Thumb } from '@/components/Thumb'
import { PageTitle } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { browseLibrary, PAGE_SIZE } from '@/server/ui/browse'
import { pageViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Library' }

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await pageViewer('submit')
  const sp = await searchParams
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 100) : ''
  const page = typeof sp.page === 'string' && /^\d{1,4}$/.test(sp.page) ? Number(sp.page) : 1
  const r = await browseLibrary(getDb(), viewer, { q: q || undefined, page })
  const pages = Math.max(1, Math.ceil(r.total / PAGE_SIZE))
  const href = (p: number) => `/library?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`
  return (
    <section>
      <PageTitle
        title="Library"
        sub="Songs on EuphoricFM. Open one to suggest an edit or ask for its removal."
        actions={
          viewer.perms.has('manage') ? (
            <Link href="/library/archived" className="btn btn-secondary">
              Archived songs
            </Link>
          ) : null
        }
      />
      <form method="get" className="card mb-5 flex flex-wrap items-end gap-3" role="search">
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
          <Link href="/library" className="btn btn-secondary">
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
          {r.songs.map((s) => (
            <li key={s.mediaId}>
              <Link href={`/library/${s.mediaId}`} className="row-link">
                <Thumb src={s.artUrl} alt="" size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.title ?? s.fileName}</span>
                  <span className="block truncate text-xs text-cream/60">
                    {[s.artist, s.album].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-cream/50">{duration(s.lengthS)}</span>
              </Link>
            </li>
          ))}
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
