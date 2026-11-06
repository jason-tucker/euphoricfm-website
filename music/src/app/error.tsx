'use client'

// Replaces Next's default error page (inline styles, forbidden by the CSP).
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="card mx-auto max-w-xl space-y-3 text-center" role="alert">
      <h1 className="text-xl font-bold text-ruby">Something went wrong</h1>
      <p className="text-cream/75">The page could not be loaded. Try again in a moment.</p>
      <button type="button" className="btn btn-secondary" onClick={() => reset()}>
        Try again
      </button>
    </section>
  )
}
