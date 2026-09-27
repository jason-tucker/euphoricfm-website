import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { Header } from '@/components/Header'
import { headerViewer } from '@/server/ui/page'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'EFM Music Portal', template: '%s · EFM Music Portal' },
  description: 'Submit music to EuphoricFM',
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a0a0a' }

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the nonce makes every page dynamic, so Next stamps it on its
  // inline scripts (the CSP has no 'unsafe-inline').
  await headers()
  const viewer = await headerViewer()
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-cream antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-sunburst focus:px-3 focus:py-2 focus:text-ink">
          Skip to content
        </a>
        <Header viewer={viewer} />
        <main id="main" className="mx-auto max-w-frame px-4 py-6 sm:py-8">
          {children}
        </main>
        <footer className="mx-auto max-w-frame px-4 pb-8 text-xs text-cream/40">
          EuphoricFM · Music Portal v{process.env.NEXT_PUBLIC_APP_VERSION}
        </footer>
      </body>
    </html>
  )
}
