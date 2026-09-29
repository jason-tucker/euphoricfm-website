import { StaffSettings } from '@/events/components/Staff'
import { pageViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Staff · Events settings' }

export default async function StaffSettingsPage() {
  await pageViewer('manage')
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <a className="link ev-back text-sm" href="/staff">
          ‹ Event requests
        </a>
        <p className="eyebrow">Staff · Managers</p>
        <h1 className="text-3xl font-bold text-cream">Events settings</h1>
        <p className="text-sm text-cream/75">Limits can be lowered freely; each has a hard ceiling the server enforces.</p>
      </header>
      <StaffSettings />
    </div>
  )
}
