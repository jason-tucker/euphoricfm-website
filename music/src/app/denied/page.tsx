import { signInWithDiscord } from '@/app/actions'
import { getDb } from '@/server/db/client'
import { inviteUrl } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Access denied' }

const REASONS: Record<string, { title: string; body: string; showInvite: boolean }> = {
  not_member: {
    title: "You're not in the EuphoricFM Discord server",
    body: 'The Music Portal is for members of the EuphoricFM Discord server. Join the server, then sign in again.',
    showInvite: true,
  },
  pending: {
    title: 'Your server membership is still pending',
    body: 'Discord says you have joined the EuphoricFM server but have not finished its membership screening yet. Open Discord, accept the server rules, then sign in again.',
    showInvite: false,
  },
  unverifiable: {
    title: "We couldn't check your membership",
    body: 'Discord did not answer in time. Wait a minute, then try again.',
    showInvite: false,
  },
}

async function safeInvite(): Promise<string | null> {
  try {
    return await inviteUrl(getDb())
  } catch {
    return null
  }
}

export default async function Denied({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const reason = typeof sp.reason === 'string' ? sp.reason : ''
  const r = REASONS[reason] ?? { title: 'Sign-in was not completed', body: 'Something interrupted sign-in. Try again.', showInvite: false }
  const invite = r.showInvite ? await safeInvite() : null
  return (
    <section className="card mx-auto max-w-xl space-y-4">
      <h1 className="text-xl font-bold text-ruby">{r.title}</h1>
      <p className="text-cream/85">{r.body}</p>
      <div className="flex flex-wrap gap-3">
        {r.showInvite ? (
          invite ? (
            <a className="btn btn-primary" href={invite} target="_blank" rel="noopener noreferrer">
              Join the EuphoricFM Discord ↗
            </a>
          ) : (
            <p className="text-sm text-cream/60">Ask a EuphoricFM member for an invite link to the Discord server.</p>
          )
        ) : null}
        <form action={signInWithDiscord}>
          <button type="submit" className="btn btn-secondary">
            Try signing in again
          </button>
        </form>
      </div>
    </section>
  )
}
