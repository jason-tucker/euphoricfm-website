import { redirect } from 'next/navigation'
import { MyAudio } from '@/events/components/MyAudio'
import { getDb } from '@/server/db/client'
import { loadCaps } from '@/server/settings'
import { DEFAULT_CAPS } from '@/server/settings-defaults'
import { evViewer } from '../../viewer'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'My audio' }

// The tus chunk size is the portal's (admin-lowerable) cap; the events
// config does not carry it.
async function chunkBytes(): Promise<number> {
  try {
    return Math.min((await loadCaps(getDb())).chunkBytes, DEFAULT_CAPS.chunkBytes)
  } catch {
    return DEFAULT_CAPS.chunkBytes
  }
}

export default async function MyAudioPage() {
  const v = await evViewer()
  if (!v) redirect('/my')
  if (!v.member) redirect('/denied?reason=not_member')
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <a className="link ev-back text-sm" href="/my">
          ‹ My events
        </a>
        <p className="eyebrow">My audio</p>
        <h1 className="text-3xl font-bold text-cream">Your own announcements and songs</h1>
        <p className="max-w-2xl text-sm text-cream/75">
          Files you upload stay here so you can reuse them at your next event. They only ever play at your events, never in normal rotation. The EuphoricFM team can remove files.
        </p>
      </header>
      <MyAudio chunkBytes={await chunkBytes()} />
    </div>
  )
}
