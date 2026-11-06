import { SITE_LINKS } from '@/components/site-links'
import { getDb } from '@/server/db/client'
import { inviteUrl } from '@/server/ui/settings'
import { evSignIn } from '../actions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Sign-in not completed' }

const REASONS: Record<string, { title: string; body: string; showInvite: boolean }> = {
  not_member: {
    title: "You're not in the EuphoricFM Discord server",
    body: 'Requesting an event is for members of the EuphoricFM Discord server (that is where your ticket opens). Join the server, then sign in again. You can still browse the calendar and listen without signing in.',
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

async function safeInvite(): Promise<string> {
  try {
    return (await inviteUrl(getDb())) ?? SITE_LINKS.discordInvite
  } catch {
    return SITE_LINKS.discordInvite
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
        {invite ? (
          <a className="btn btn-primary" href={invite} target="_blank" rel="noopener noreferrer">
            Join the EuphoricFM Discord ↗
          </a>
        ) : null}
        <form action={evSignIn}>
          <button type="submit" className="btn btn-secondary">
            Try signing in again
          </button>
        </form>
        <a className="btn btn-secondary" href="/calendar">
          Browse the calendar
        </a>
      </div>
    </section>
  )
}
