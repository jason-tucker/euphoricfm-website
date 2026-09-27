import type { Metadata } from 'next'
import { headers } from 'next/headers'
import './globals.css'

export const metadata: Metadata = {
  title: 'EFM Music Portal',
  description: 'Submit music to EuphoricFM',
  robots: { index: false, follow: false },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the nonce makes every page dynamic, so Next stamps it on its
  // inline scripts (the CSP has no 'unsafe-inline').
  await headers()
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-cream antialiased">
        <main className="mx-auto max-w-frame p-6">{children}</main>
      </body>
    </html>
  )
}
