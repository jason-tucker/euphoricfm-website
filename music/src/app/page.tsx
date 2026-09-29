import { redirect } from 'next/navigation'
import { ActionCards, MyMusicCard, ReviewQueueCard } from '@/components/HomeActions'
import { SignedInInfo, SignedOutInfo, type HomeInfoData } from '@/components/home/HomeInfo'
import { openGraph } from '@/components/og'
import { SITE_LINKS } from '@/components/site-links'
import { safeNext } from '@/lib/next-path'
import { isReviewer } from '@/server/authz/predicates'
import { getDb } from '@/server/db/client'
import { uploadLimitsForUi } from '@/server/ui/limits'
import { headerViewer } from '@/server/ui/page'
import { memberSummary, reviewSummary } from '@/server/ui/queries'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'

export const metadata = {
  description: 'Send your songs to EuphoricFM: sign in with Discord, upload, and follow each song through review to the air.',
  openGraph: openGraph('EuphoricFM Music Portal', 'Send your songs to EuphoricFM and follow them through review to the air.', '/'),
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await headerViewer()
  // v0.4.1: where a signed-out visitor was going (server/ui/page.ts).
  const next = safeNext((await searchParams).next)
  if (viewer && next) redirect(next)
  const db = getDb()
  const [s, mine, queue] = await Promise.all([
    uiSettings(db),
    viewer ? memberSummary(db, viewer) : null,
    viewer && isReviewer(viewer) ? reviewSummary(db, viewer) : null,
  ])
  const data: HomeInfoData = {
    limits: uploadLimitsForUi(s.caps),
    // The same setting the submit page shows (and records the version of).
    rights: s.rights,
    requestCaps: s.requestCaps,
    autoCloseDays: s.autoCloseDays,
    inviteUrl: s.inviteUrl ?? SITE_LINKS.discordInvite,
    soundcloudEnabled: s.soundcloudEnabled,
  }

  if (!viewer) return <SignedOutInfo data={data} next={next} />

  return (
    <div className="space-y-10">
      <section aria-labelledby="todo-h" className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl" data-testid="greeting">
            Welcome back{viewer.name ? `, ${viewer.name}` : ''}
          </h1>
          <h2 id="todo-h" className="mt-1 text-base font-normal text-cream/70">
            What do you want to do?
          </h2>
        </div>
        <ActionCards perms={viewer.perms} soundcloudEnabled={s.soundcloudEnabled} />
        <div className={`grid gap-3 ${queue ? 'md:grid-cols-2' : ''}`}>
          {mine ? <MyMusicCard summary={mine} /> : null}
          {queue ? <ReviewQueueCard summary={queue} /> : null}
        </div>
      </section>
      <SignedInInfo data={data} />
    </div>
  )
}
