import Link from 'next/link'
import { playlistLabel } from '@/components/format'
import { QueueList } from '@/components/review/QueueList'
import { PageTitle } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { pageViewer } from '@/server/ui/page'
import { reviewQueue, type QueueFilters } from '@/server/ui/queries'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Review queue' }

function one(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v : ''
}

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await pageViewer('review')
  const db = getDb()
  const sp = await searchParams
  const f: QueueFilters = {
    q: one(sp.q).trim().slice(0, 100) || undefined,
    kind: one(sp.kind) === 'song' || one(sp.kind) === 'new_artist' ? (one(sp.kind) as QueueFilters['kind']) : undefined,
    source: one(sp.source) === 'upload' || one(sp.source) === 'soundcloud' ? (one(sp.source) as QueueFilters['source']) : undefined,
    mine: one(sp.mine) === '1' || undefined,
    batchId: /^[1-9]\d{0,9}$/.test(one(sp.batch)) ? Number(one(sp.batch)) : undefined,
  }
  const [groups, s] = await Promise.all([reviewQueue(db, viewer, f), uiSettings(db)])
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const filtered = Boolean(f.q || f.kind || f.source || f.mine || f.batchId)

  return (
    <section>
      <PageTitle title="Review queue" sub={`${total} pending item${total === 1 ? '' : 's'}, oldest first.`} />

      <form method="get" className="card mb-5 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto_auto] sm:items-end" role="search">
        <div>
          <label className="label" htmlFor="q">
            Search
          </label>
          <input id="q" name="q" className="input" defaultValue={f.q ?? ''} placeholder="Title, artist or submitter" />
        </div>
        <div>
          <label className="label" htmlFor="kind">
            Type
          </label>
          <select id="kind" name="kind" className="input" defaultValue={f.kind ?? ''}>
            <option value="">All</option>
            <option value="song">Songs</option>
            <option value="new_artist">New artists</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="source">
            Source
          </label>
          <select id="source" name="source" className="input" defaultValue={f.source ?? ''}>
            <option value="">All</option>
            <option value="upload">Upload</option>
            <option value="soundcloud">SoundCloud</option>
          </select>
        </div>
        <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
          <input type="checkbox" name="mine" value="1" className="checkbox" defaultChecked={Boolean(f.mine)} />
          Only mine
        </label>
        <div className="flex gap-2">
          {f.batchId ? <input type="hidden" name="batch" value={f.batchId} /> : null}
          <button type="submit" className="btn btn-secondary">
            Apply
          </button>
          {filtered ? (
            <Link href="/review" className="btn btn-secondary">
              Clear
            </Link>
          ) : null}
        </div>
      </form>
      {f.batchId ? <p className="mb-3 text-sm text-cream/70">Showing batch #{f.batchId} only.</p> : null}

      {groups.length === 0 ? (
        <p className="card text-center text-cream/70">{filtered ? 'Nothing matches these filters.' : 'The queue is empty. Nice work.'}</p>
      ) : (
        <QueueList groups={groups} defaultPlaylistLabels={s.defaultPlaylistIds.map((id) => playlistLabel(s.playlistNames, id))} />
      )}
    </section>
  )
}
