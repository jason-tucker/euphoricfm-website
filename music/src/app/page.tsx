import Link from 'next/link'
import { signInWithDiscord } from '@/app/actions'
import { headerViewer } from '@/server/ui/page'

export const dynamic = 'force-dynamic'

const STEPS = [
  { t: 'Sign in with Discord', d: 'The portal is for members of the EuphoricFM Discord server. We only read your server membership.' },
  { t: 'Upload your MP3s', d: 'Drop in one or more songs (MP3, up to 35 MB each). We read the tags and cover art for you, and you can fix anything that is wrong.' },
  { t: 'Managers review', d: 'Each batch opens a ticket in Discord. Managers listen, then approve or decline each song, with a reason if declined.' },
  { t: 'On air', d: 'Approved songs are added to the station and go into rotation. Track every song’s status from your dashboard.' },
]

export default async function Home() {
  const viewer = await headerViewer()
  return (
    <section className="space-y-8">
      <div className="card space-y-4 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cream/55">EuphoricFM Music Portal</p>
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
          Get your music on <span className="text-sunburst">Euphoric</span>
          <span className="text-ruby">FM</span>
        </h1>
        <p className="max-w-2xl text-cream/80">
          Submit your songs for airplay, follow each one through review, and talk to the managers, all in one place.
        </p>
        {viewer ? (
          <div className="flex flex-wrap gap-3">
            <Link href="/dashboard" className="btn btn-primary">
              Go to my music
            </Link>
            <Link href="/submit" className="btn btn-secondary">
              Submit songs
            </Link>
          </div>
        ) : (
          <form action={signInWithDiscord}>
            <button type="submit" className="btn btn-primary px-6 text-base">
              <DiscordMark /> Sign in with Discord
            </button>
            <p className="mt-2 text-xs text-cream/55">You need to be a member of the EuphoricFM Discord server.</p>
          </form>
        )}
      </div>

      <ol className="grid gap-3 sm:grid-cols-2">
        {STEPS.map((s, i) => (
          <li key={s.t} className="card">
            <p className="text-xs font-bold text-sunburst">Step {i + 1}</p>
            <h2 className="mt-1 font-semibold">{s.t}</h2>
            <p className="mt-1 text-sm text-cream/70">{s.d}</p>
          </li>
        ))}
      </ol>

      <p className="text-xs text-cream/50">
        Only upload music you own or have permission to share. Every submission asks you to confirm this.
      </p>
    </section>
  )
}

function DiscordMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 fill-current">
      <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.8-9.7-3.6-13.7ZM8 15.4c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.6 8 10.6s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
    </svg>
  )
}
