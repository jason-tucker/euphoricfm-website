import { redirect } from 'next/navigation'
import { MemberRules } from '@/events/components/HomeParts'
import { RequestWizard } from '@/events/components/RequestWizard'
import { RequestCta } from '../RequestCta'
import { evViewer } from '../viewer'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Request an event' }

export default async function RequestPage() {
  const v = await evViewer()
  if (v && !v.member) redirect('/denied?reason=not_member')
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="eyebrow">Request an event</p>
        <h1 className="text-3xl font-bold text-cream">Plan your event</h1>
        <p className="max-w-2xl text-sm text-cream/75">
          Five short steps. Your request is saved as a draft after step 3, so you can finish the playlist later from My events.
        </p>
      </header>
      {v ? (
        <RequestWizard staff={v.review} />
      ) : (
        <section className="card space-y-3">
          <h2 className="text-lg font-bold text-cream">Sign in first</h2>
          <p className="text-sm text-cream/80">
            Requests are for members of the EuphoricFM Discord server: your request opens a ticket there, so we sign you in with Discord.
          </p>
          <RequestCta signedIn={false} label="Sign in with Discord" />
        </section>
      )}
      <MemberRules />
    </div>
  )
}
