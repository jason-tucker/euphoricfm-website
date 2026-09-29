import { notFound, redirect } from 'next/navigation'
import { EventEditor } from '@/events/components/EventEditor'
import { uploadChunkBytes } from '../../../chunk'
import { evViewer } from '../../../viewer'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Your event' }

export default async function MyEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[1-9]\d{0,15}$/.test(id)) notFound()
  const v = await evViewer()
  if (!v) redirect('/my')
  if (!v.member) redirect('/denied?reason=not_member')
  return (
    <div className="space-y-4">
      <a className="link ev-back text-sm" href="/my">
        ‹ My events
      </a>
      <EventEditor id={Number(id)} staff={v.review} viewerDiscordId={v.discordId} chunkBytes={await uploadChunkBytes()} />
    </div>
  )
}
