'use client'

import './globals.css'

// Last-resort error boundary (the root layout itself failed). Styled from the
// stylesheet only: the CSP forbids inline styles.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-cream antialiased">
        <main className="mx-auto max-w-frame px-4 py-10">
          <section className="card mx-auto max-w-xl space-y-3 text-center" role="alert">
            <h1 className="text-xl font-bold text-ruby">The portal is having trouble</h1>
            <p className="text-cream/75">Try again in a minute.</p>
            <button type="button" className="btn btn-secondary" onClick={() => reset()}>
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  )
}
