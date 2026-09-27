import { redirect } from 'next/navigation'
import { signOut } from '@/server/auth/config'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'
import { listOwnItems } from '@/server/submissions'

export const dynamic = 'force-dynamic'

// Minimal P2 dashboard: the member's OWN items only (listOwnItems filters by
// owner). The UI pass replaces this.
export default async function Dashboard() {
  let viewer
  try {
    viewer = await requirePermission('submit')
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) redirect('/')
    throw e
  }
  const own = await listOwnItems(getDb(), viewer)
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-bold text-sunburst">Your submissions</h1>
      <ul className="space-y-2" data-testid="own-items">
        {own.map((it) => (
          <li key={it.id} data-item-id={it.id} className="rounded border border-cream/10 p-3">
            #{it.id} · {it.title ?? '(untitled)'} · {it.status}
          </li>
        ))}
      </ul>
      <form
        action={async () => {
          'use server'
          await signOut({ redirectTo: '/' })
        }}
      >
        <button type="submit" className="underline">Sign out</button>
      </form>
    </section>
  )
}
