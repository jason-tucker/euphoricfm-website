import { redirect } from 'next/navigation'
import { MyEvents } from '@/events/components/MyEvents'
import { evSignInToMy } from '../actions'
import { evViewer } from '../viewer'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'My events' }

export default async function MyPage() {
  const v = await evViewer()
  if (v && !v.member) redirect('/denied?reason=not_member')
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="eyebrow">My events</p>
          <h1 className="text-3xl font-bold text-cream">Your requests and events</h1>
        </div>
        {v ? (
          <div className="flex flex-wrap gap-2">
            <a className="btn btn-primary" href="/request">
              Request an event
            </a>
            <a className="btn btn-secondary" href="/my/audio">
              My audio
            </a>
          </div>
        ) : null}
      </header>
      {v ? (
        <MyEvents />
      ) : (
        <section className="card space-y-3">
          <p className="text-sm text-cream/80">Sign in with Discord to see your events.</p>
          <form action={evSignInToMy}>
            <button type="submit" className="btn btn-discord">
              Sign in with Discord
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
