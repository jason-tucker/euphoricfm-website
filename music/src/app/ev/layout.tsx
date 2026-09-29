import type { Metadata } from 'next'
import { EventsBar } from '@/events/components/EventsBar'
import { TzProvider } from '@/events/components/tz'
import { evViewer } from './viewer'
import '@/events/components/events.css'

// The events site (events.euphoric.fm; the middleware rewrites /x → /ev/x).
// Expects the root layout to render only <html>/<body> on the events host
// (PORTAL_SITE=events), so this layout owns the bar, <main> and footer.

export const metadata: Metadata = {
  title: { default: 'EuphoricFM Events', template: '%s · EuphoricFM Events' },
  description: 'Book EuphoricFM Event Radio for your event: pick the songs, schedule announcements, and listen live.',
}

export default async function EventsLayout({ children }: { children: React.ReactNode }) {
  const viewer = await evViewer()
  return (
    <TzProvider>
      <div className="ev-root">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-sunburst focus:px-3 focus:py-2 focus:text-ink">
          Skip to content
        </a>
        <EventsBar viewer={viewer} />
        <main id="main" className="mx-auto max-w-frame px-4 py-6 sm:py-8 md:px-6">
          {children}
        </main>
        <footer className="mx-auto flex max-w-frame flex-wrap gap-x-4 gap-y-2 px-4 pb-8 text-xs text-cream/50 md:px-6">
          <span>EuphoricFM Events · v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
          <a className="link" href="/how-it-works">
            How it works
          </a>
          <a className="link" href="/api/ev/calendar.ics">
            Calendar feed (ICS)
          </a>
          <a className="link" href="https://info.euphoric.fm/">
            info.euphoric.fm
          </a>
          <a className="link" href="https://music.euphoric.fm/">
            music.euphoric.fm
          </a>
        </footer>
      </div>
    </TzProvider>
  )
}
