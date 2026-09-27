import Link from 'next/link'
import { duration, playlistLabel, when } from '@/components/format'
import { ManagerTools } from '@/components/requests/ManagerTools'
import { RequestForms } from '@/components/requests/RequestForms'
import { Notice, PageTitle, RequestStatusChip } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { parseId } from '@/server/http/route'
import { librarySong } from '@/server/ui/browse'
import { orNotFound, pageViewer } from '@/server/ui/page'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Song' }

export default async function SongPage({ params }: { params: Promise<{ mediaId: string }> }) {
  const viewer = await pageViewer('submit')
  const db = getDb()
  const { mediaId: raw } = await params
  const mediaId = await orNotFound(async () => parseId(raw))
  const [r, s] = await Promise.all([orNotFound(() => librarySong(db, viewer, mediaId)), uiSettings(db)])
  const song = r.song
  const current = { title: song.title ?? '', artist: song.artist ?? '', album: song.album ?? '', genre: song.genre ?? '' }
  const openMine = r.myRequests.find((q) => ['pending', 'approved', 'applying', 'verifying'].includes(q.status))
  const assignable = s.assignablePlaylistIds.map((id) => ({ id, label: playlistLabel(s.playlistNames, id) }))
  const others = (song.playlistIds ?? []).filter((id) => !s.assignablePlaylistIds.includes(id)).map((id) => playlistLabel(s.playlistNames, id))

  return (
    <section className="space-y-6">
      <p>
        <Link href="/library" className="link text-sm">
          ‹ Library
        </Link>
      </p>
      <PageTitle title={song.title ?? song.fileName} sub={[song.artist, song.album].filter(Boolean).join(' · ')} />

      <div className="card">
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
          <dt className="text-cream/55">Artist</dt>
          <dd>{song.artist ?? '—'}</dd>
          <dt className="text-cream/55">Album</dt>
          <dd>{song.album ?? '—'}</dd>
          <dt className="text-cream/55">Genre</dt>
          <dd>{song.genre ?? '—'}</dd>
          <dt className="text-cream/55">Length</dt>
          <dd>{duration(song.lengthS) || '—'}</dd>
          <dt className="text-cream/55">Folder</dt>
          <dd className="break-all">Music/Artists/{song.folder}</dd>
          {song.playlistIds ? (
            <>
              <dt className="text-cream/55">Playlists</dt>
              <dd>{song.playlistIds.length ? song.playlistIds.map((id) => playlistLabel(s.playlistNames, id)).join(', ') : 'none'}</dd>
            </>
          ) : null}
        </dl>
      </div>

      {r.myRequests.length ? (
        <div className="card space-y-2">
          <h2 className="text-sm font-semibold text-cream/80">Your requests for this song</h2>
          <ul className="space-y-1 text-sm">
            {r.myRequests.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {q.kind === 'edit' ? 'Edit' : 'Removal'} request #{q.id} · {when(q.createdAt)}
                </span>
                <RequestStatusChip status={q.status} />
              </li>
            ))}
          </ul>
          <Link href="/dashboard#requests" className="link text-xs">
            Follow them on My music
          </Link>
        </div>
      ) : null}

      {viewer.perms.has('request') ? (
        openMine ? (
          <Notice tone="info">You already have an open request (#{openMine.id}) for this song. Withdraw it from My music to file a different one.</Notice>
        ) : (
          <RequestForms mediaId={song.mediaId} current={current} />
        )
      ) : null}
      {r.openRequests > 0 && viewer.perms.has('review') ? <Notice tone="warn">This song has {r.openRequests} open request(s). See Review → Requests.</Notice> : null}

      {viewer.perms.has('manage') ? (
        <ManagerTools mediaId={song.mediaId} current={current} playlistIds={song.playlistIds ?? []} assignable={assignable} otherPlaylistLabels={others} />
      ) : null}
    </section>
  )
}
