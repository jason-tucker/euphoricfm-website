import { Calendar } from '@/events/components/Calendar'

export const metadata = { title: 'Calendar' }

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const m = typeof sp.m === 'string' ? sp.m : null
  const view = sp.view === 'list' ? 'list' : 'grid'
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="eyebrow">Calendar</p>
          <h1 className="text-3xl font-bold text-cream">What&apos;s booked on Event Radio</h1>
          <p className="text-sm text-cream/75">Public events show their details. Private events and requests waiting for review only hold their time.</p>
        </div>
        <a className="btn btn-secondary" href="/api/ev/calendar.ics">
          Add to your calendar (ICS)
        </a>
      </header>
      <Calendar initialMonth={m} initialView={view} />
    </div>
  )
}
