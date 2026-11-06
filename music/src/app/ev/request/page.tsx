import { redirect } from 'next/navigation'
import { MemberRules } from '@/events/components/HomeParts'
import { RequestForm } from '@/events/components/RequestForm'
import { RequestCta } from '../RequestCta'
import { uploadChunkBytes } from '../chunk'
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
          One page, saved as you go: once it has a title, kind, time and visibility it is kept as a draft in My events, and every change after that saves by itself. Submit at the bottom when it&apos;s ready.
        </p>
      </header>
      {v ? (
        <RequestForm staff={v.review} userKey={v.discordId} chunkBytes={await uploadChunkBytes()} />
      ) : (
        <section className="card space-y-3">
          <h2 className="text-lg font-bold text-cream">Sign in first</h2>
          <p className="text-sm text-cream/80">
            Requests are for members of the EuphoricFM Discord server: your request opens a ticket there, so we sign you in with Discord.
          </p>
          <RequestCta signedIn={false} label="Sign in with Discord" />
        </section>
      )}
      {v ? null : <MemberRules />}
    </div>
  )
}
