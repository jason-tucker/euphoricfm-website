import { redirect } from 'next/navigation'
import { SubmitFlow } from '@/components/submit/SubmitFlow'
import { PageTitle } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { orNotFound, pageViewer } from '@/server/ui/page'
import { batchDetail } from '@/server/ui/queries'
import { DEFAULT_CAPS } from '@/server/settings-defaults'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Submit songs' }

export default async function SubmitPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await pageViewer('submit')
  const db = getDb()
  const sp = await searchParams
  const raw = typeof sp.batch === 'string' && /^[1-9]\d{0,9}$/.test(sp.batch) ? Number(sp.batch) : null
  let batch = null
  if (raw) {
    batch = await orNotFound(() => batchDetail(db, viewer, raw))
    // Only the owner continues a draft; anything else goes to its detail page.
    if (!batch.isOwn || batch.status !== 'draft') redirect(`/batches/${batch.id}`)
  }
  const s = await uiSettings(db)
  return (
    <section>
      <PageTitle title="Submit songs" sub="Upload MP3s, check the details we read from each file, then send the batch to the managers." />
      <SubmitFlow
        initialBatchId={batch?.id ?? null}
        initialItems={batch?.items ?? []}
        rights={s.rights}
        // The tus route enforces the compiled defaults, so never exceed them.
        maxUploadBytes={Math.min(s.caps.maxUploadBytes, DEFAULT_CAPS.maxUploadBytes)}
        chunkBytes={Math.min(s.caps.chunkBytes, DEFAULT_CAPS.chunkBytes)}
        maxItemsPerBatch={s.caps.maxItemsPerBatch}
      />
    </section>
  )
}
