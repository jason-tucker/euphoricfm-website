import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { Header } from '@/components/Header'
import { headerViewer } from '@/server/ui/page'
// One stylesheet (v0.4.1): globals.css @imports the shared top bar styles.
import './globals.css'
import { openGraph, SITE_NAME as SITE } from '@/components/og'

const DESCRIPTION = 'Where artists send their songs to EuphoricFM and follow each one through review to the air.'

const musicMetadata: Metadata = {
  metadataBase: new URL('https://music.euphoric.fm'),
  title: { default: SITE, template: `%s · ${SITE}` },
  description: DESCRIPTION,
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
  openGraph: openGraph(SITE, DESCRIPTION),
  twitter: { card: 'summary_large_image' },
}

// Per request (not a static export): one image serves both sites. On the
// events host app/ev/layout.tsx supplies the titles.
export function generateMetadata(): Metadata {
  return process.env.PORTAL_SITE === 'events' ? { icons: { icon: '/favicon.svg' } } : musicMetadata
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a0a0a' }

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the nonce makes every page dynamic, so Next stamps it on its
  // inline scripts (the CSP has no 'unsafe-inline').
  await headers()
  // v0.5.0: on events.euphoric.fm app/ev/layout.tsx owns the bar, <main> and footer.
  if (process.env.PORTAL_SITE === 'events') {
    return (
      <html lang="en">
        <body className="min-h-screen bg-ink text-cream antialiased">{children}</body>
      </html>
    )
  }
  const viewer = await headerViewer()
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-cream antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-sunburst focus:px-3 focus:py-2 focus:text-ink">
          Skip to content
        </a>
        <Header viewer={viewer} />
        <main id="main" className="mx-auto max-w-frame px-4 py-6 sm:py-8 md:px-6">
          {children}
        </main>
        <footer className="mx-auto max-w-frame px-4 pb-8 text-xs text-cream/55 md:px-6">
          EuphoricFM · Music Portal v{process.env.NEXT_PUBLIC_APP_VERSION}
        </footer>
      </body>
    </html>
  )
}
