import { notFound, redirect } from 'next/navigation'
import { getDb } from '@/server/db/client'
import { orNotFound, pageViewer } from '@/server/ui/page'
import { requestLinkTarget } from '@/server/ui/request-link'

export const dynamic = 'force-dynamic'

// v0.4.1: the target of an edit / removal ticket's "Open in portal" button
// (it used to be a 404). Redirects the requester to the song (or Archived
// songs) and a reviewer to the request in the queue; anyone else gets 404,
// and a signed-out visitor signs in and comes back here.
export default async function RequestLink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[1-9]\d{0,9}$/.test(id)) notFound()
  const viewer = await pageViewer('request')
  const to = await orNotFound(() => requestLinkTarget(getDb(), viewer, Number(id)))
  redirect(to)
}
