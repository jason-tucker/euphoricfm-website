import { StaffQueueView } from '@/events/components/Staff'
import { pageViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Staff' }

export default async function StaffPage() {
  const v = await pageViewer('review')
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="eyebrow">Staff</p>
        <h1 className="text-3xl font-bold text-cream">Event requests</h1>
        <p className="text-sm text-cream/75">Approve or deny requests, change visibility, cancel, and book events directly.</p>
      </header>
      <StaffQueueView manage={v.perms.has('manage')} />
    </div>
  )
}
