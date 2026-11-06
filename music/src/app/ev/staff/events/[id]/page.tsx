import { notFound } from 'next/navigation'
import { EventEditor } from '@/events/components/EventEditor'
import { StaffDecision } from '@/events/components/Staff'
import { pageViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Staff · Event' }

export default async function StaffEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[1-9]\d{0,15}$/.test(id)) notFound()
  const v = await pageViewer('review')
  return (
    <div className="space-y-6">
      <a className="link ev-back text-sm" href="/staff">
        ‹ Event requests
      </a>
      <StaffDecision id={Number(id)} manage={v.perms.has('manage')} />
      <EventEditor id={Number(id)} staff viewerDiscordId={v.discordId} />
    </div>
  )
}
