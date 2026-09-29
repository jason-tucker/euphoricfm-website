import { notFound } from 'next/navigation'
import { EventDetail } from '@/events/components/EventDetail'
import { evViewer } from '../../viewer'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Event' }

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[1-9]\d{0,15}$/.test(id)) notFound()
  const v = await evViewer()
  return (
    <div className="mx-auto max-w-2xl">
      <EventDetail id={Number(id)} viewer={v ? { discordId: v.discordId, review: v.review } : null} />
    </div>
  )
}
