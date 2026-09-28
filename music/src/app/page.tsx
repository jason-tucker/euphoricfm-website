import { ActionCards, MyMusicCard, ReviewQueueCard } from '@/components/HomeActions'
import { SignedInInfo, SignedOutInfo, type HomeInfoData } from '@/components/home/HomeInfo'
import { SITE_LINKS } from '@/components/site-links'
import { isReviewer } from '@/server/authz/predicates'
import { getDb } from '@/server/db/client'
import { dailyCaps } from '@/server/requests/service'
import { uploadLimitsForUi } from '@/server/ui/limits'
import { headerViewer } from '@/server/ui/page'
import { memberSummary, reviewSummary } from '@/server/ui/queries'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const viewer = await headerViewer()
  const db = getDb()
  const [s, requestCaps, mine, queue] = await Promise.all([
    uiSettings(db),
    dailyCaps(db),
    viewer ? memberSummary(db, viewer) : null,
    viewer && isReviewer(viewer) ? reviewSummary(db, viewer) : null,
  ])
  const data: HomeInfoData = {
    limits: uploadLimitsForUi(s.caps),
    // The same setting the submit page shows (and records the version of).
    rights: s.rights,
    requestCaps,
    autoCloseDays: s.autoCloseDays,
    inviteUrl: s.inviteUrl ?? SITE_LINKS.discordInvite,
  }

  if (!viewer) return <SignedOutInfo data={data} />

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
        <ActionCards perms={viewer.perms} />
        <div className={`grid gap-3 ${queue ? 'md:grid-cols-2' : ''}`}>
          {mine ? <MyMusicCard summary={mine} /> : null}
          {queue ? <ReviewQueueCard summary={queue} /> : null}
        </div>
      </section>
      <SignedInInfo data={data} />
    </div>
  )
}
