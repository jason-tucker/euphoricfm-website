import Link from 'next/link'
import { signIn } from '@/server/auth/config'
import { currentUser } from '@/server/authz/viewer'

export const dynamic = 'force-dynamic'

// Minimal P2 landing page: sign-in, or a link to the dashboard. The UI pass
// replaces this.
export default async function Home() {
  const user = await currentUser().catch(() => null)
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold text-sunburst">EFM Music Portal</h1>
      {user ? (
        <p>
          Signed in as {user.name ?? user.discordId}. <Link className="underline" href="/dashboard">Your submissions</Link>
        </p>
      ) : (
        <form
          action={async () => {
            'use server'
            await signIn('discord', { redirectTo: '/dashboard' })
          }}
        >
          <button type="submit" className="rounded bg-sunburst px-4 py-3 font-semibold text-ink">
            Sign in with Discord
          </button>
        </form>
      )}
    </section>
  )
}
