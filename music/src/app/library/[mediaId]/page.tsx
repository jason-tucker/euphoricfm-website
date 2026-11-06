import Link from 'next/link'
import { duration, playlistLabel } from '@/components/format'
import { LocalTime } from '@/components/LocalTime'
import { parseIntent } from '@/components/HomeActions'
import { ManagerTools } from '@/components/requests/ManagerTools'
import { RequestForms } from '@/components/requests/RequestForms'
import { Thumb } from '@/components/Thumb'
import { Notice, PageTitle, RequestStatusChip } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { parseId } from '@/server/http/route'
import { librarySong } from '@/server/ui/browse'
import { orNotFound, pageViewer } from '@/server/ui/page'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Song', description: 'A song on EuphoricFM: its details, and edit or removal requests.' }

export default async function SongPage({
  params,
  searchParams,
}: {
  params: Promise<{ mediaId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const viewer = await pageViewer('submit')
  const db = getDb()
  const { mediaId: raw } = await params
  // ?request=edit|remove (from the library's "Suggest edit" / "Request removal") opens that form.
  const intent = parseIntent((await searchParams).request)
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
        <Link href={intent ? `/library?intent=${intent}` : '/library'} className="link text-sm">
          ‹ Library
        </Link>
      </p>
      <PageTitle title={song.title ?? song.fileName} sub={[song.artist, song.album].filter(Boolean).join(' · ')} />

      <div className="card flex flex-wrap items-start gap-4">
        <Thumb src={song.artUrl} alt={`Album art for ${song.title ?? song.fileName}`} size="xl" />
        <dl className="grid min-w-0 flex-1 grid-cols-[7rem_1fr] gap-y-1 text-sm">
          <dt className="text-cream/55">Artist</dt>
          <dd>{song.artist ?? '—'}</dd>
          <dt className="text-cream/55">Album</dt>
          <dd>{song.album ?? '—'}</dd>
          <dt className="text-cream/55">Genre</dt>
          <dd>{song.genre ?? '—'}</dd>
          <dt className="text-cream/55">Length</dt>
          <dd>{duration(song.lengthS) || '—'}</dd>
          {viewer.perms.has('review') ? (
            <>
              <dt className="text-cream/55">Folder</dt>
              <dd className="break-all">Music/Artists/{song.folder}</dd>
            </>
          ) : null}
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
                  {q.kind === 'edit' ? 'Edit' : 'Removal'} request #{q.id} · <LocalTime iso={q.createdAt} />
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
        <div id="request-form" className="scroll-mt-4 space-y-3">
          <h2 className="text-lg font-bold">{intent === 'remove' ? 'Ask to remove this song' : intent === 'edit' ? 'Fix this song’s info or cover' : 'Request a change'}</h2>
          {openMine ? (
            <Notice tone="info">You already have an open request (#{openMine.id}) for this song. Withdraw it from My music to file a different one.</Notice>
          ) : (
            <RequestForms mediaId={song.mediaId} current={current} currentArtUrl={song.artUrl} initialTab={intent === 'remove' ? 'removal' : 'edit'} />
          )}
        </div>
      ) : null}
      {r.openRequests > 0 && viewer.perms.has('review') ? <Notice tone="warn">This song has {r.openRequests} open request(s). See Review → Requests.</Notice> : null}

      {viewer.perms.has('manage') ? (
        <ManagerTools mediaId={song.mediaId} current={current} artUrl={song.artUrl} playlistIds={song.playlistIds ?? []} assignable={assignable} otherPlaylistLabels={others} />
      ) : null}
    </section>
  )
}
