import { StaffBook } from '@/events/components/Staff'
import { pageViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Staff · Book an event' }

export default async function StaffBookPage() {
  await pageViewer('review')
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <a className="link text-sm" href="/staff">
          ‹ Event requests
        </a>
        <p className="eyebrow">Staff</p>
        <h1 className="text-3xl font-bold text-cream">Book an event directly</h1>
      </header>
      <StaffBook />
    </div>
  )
}
