import Link from 'next/link'

// Replaces Next's default 404, which uses inline styles the CSP forbids.
export default function NotFound() {
  return (
    <section className="card mx-auto max-w-xl space-y-3 text-center">
      <h1 className="text-xl font-bold text-sunburst">Page not found</h1>
      <p className="text-cream/75">This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Link href="/dashboard" className="btn btn-secondary">
        Go to my music
      </Link>
    </section>
  )
}
