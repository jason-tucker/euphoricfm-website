import { redirect } from 'next/navigation'
import { SubmitFlow } from '@/components/submit/SubmitFlow'
import { PageTitle } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { orNotFound, pageViewer } from '@/server/ui/page'
import { batchDetail } from '@/server/ui/queries'
import { DEFAULT_CAPS } from '@/server/settings-defaults'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'

// A saved cap may be lowered, never raised past the compiled default.
const capOf = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : max)
export const metadata = { title: 'Submit songs', description: 'Upload your songs to EuphoricFM for review.' }

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
      <PageTitle
        title="Submit songs"
        sub={
          s.soundcloudEnabled
            ? 'Upload MP3s or WAVs, or paste a public SoundCloud track link, check the details we read from each song, then send the batch to the managers.'
            : 'Upload MP3s or WAVs, check the details we read from each file, then send the batch to the managers.'
        }
      />
      <SubmitFlow
        initialBatchId={batch?.id ?? null}
        initialItems={batch?.items ?? []}
        rights={s.rights}
        // The tus route enforces the compiled defaults, so never exceed them.
        // The MP3 INPUT cap (v0.3.5: maxMp3UploadBytes, 100 MB), not the
        // 35 MB final-file cap maxUploadBytes: a bigger MP3 is converted down.
        maxMp3UploadBytes={capOf(s.caps.maxMp3UploadBytes, DEFAULT_CAPS.maxMp3UploadBytes)}
        maxWavUploadBytes={capOf(s.caps.maxWavUploadBytes, DEFAULT_CAPS.maxWavUploadBytes)}
        chunkBytes={Math.min(s.caps.chunkBytes, DEFAULT_CAPS.chunkBytes)}
        maxItemsPerBatch={s.caps.maxItemsPerBatch}
        soundcloudEnabled={s.soundcloudEnabled}
        fetchesPerDay={capOf(s.caps.fetchesPerUserPerDay, DEFAULT_CAPS.fetchesPerUserPerDay)}
      />
    </section>
  )
}
