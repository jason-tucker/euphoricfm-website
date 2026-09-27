import { HealthPanel } from '@/components/admin/HealthPanel'
import { RoleBindings } from '@/components/admin/RoleBindings'
import { SettingsForm } from '@/components/admin/SettingsForm'
import { bytes, when } from '@/components/format'
import { ITEM_STATUS } from '@/components/messages'
import { PageTitle } from '@/components/ui'
import { getDb } from '@/server/db/client'
import { pageViewer } from '@/server/ui/page'
import { adminOverview } from '@/server/ui/queries'
import { uiSettings } from '@/server/ui/settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Admin' }

export default async function AdminPage() {
  const viewer = await pageViewer('admin')
  const db = getDb()
  const [o, s] = await Promise.all([adminOverview(db, viewer), uiSettings(db)])
  const failedJobs = (o.jobCounts.failed ?? 0) + (o.jobCounts.dead ?? 0)
  return (
    <section className="space-y-6">
      <PageTitle title="Admin" sub="Portal settings, reviewer roles and health." />

      <section className="card space-y-4" aria-labelledby="health-h">
        <h2 id="health-h" className="text-lg font-bold">
          Health
        </h2>
        <HealthPanel />
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Pending review" value={o.itemCounts.pending ?? 0} />
          <Stat label="Ingesting / verifying" value={(o.itemCounts.approved ?? 0) + (o.itemCounts.applying ?? 0) + (o.itemCounts.verifying ?? 0)} />
          <Stat label="Failed items" value={o.itemCounts.failed ?? 0} bad={(o.itemCounts.failed ?? 0) > 0} />
          <Stat label="Failed / dead jobs" value={failedJobs} bad={failedJobs > 0} />
          <Stat label="Queued jobs" value={(o.jobCounts.queued ?? 0) + (o.jobCounts.running ?? 0)} />
          <Stat label="Uploads in flight" value={`${o.uploadsInFlight.n} (${bytes(o.uploadsInFlight.bytes)})`} />
          <Stat label="Comments not yet in ticket" value={o.unsentPublicComments} />
          <Stat label="Live songs" value={o.itemCounts.live ?? 0} />
        </dl>
        <details className="text-xs text-cream/60">
          <summary className="cursor-pointer hover:text-cream">All item statuses</summary>
          <ul className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-4">
            {Object.entries(o.itemCounts).map(([k, n]) => (
              <li key={k}>
                {ITEM_STATUS[k]?.label ?? k}: {n}
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section className="card space-y-4" aria-labelledby="settings-h">
        <h2 id="settings-h" className="text-lg font-bold">
          Settings
        </h2>
        <SettingsForm
          initial={{
            assignablePlaylistIds: s.assignablePlaylistIds,
            stationPlaylistIds: s.stationPlaylistIds,
            foreignPlaylistIds: s.foreignPlaylistIds,
            unconfirmedPlaylistIds: s.unconfirmedPlaylistIds,
            defaultPlaylistIds: s.defaultPlaylistIds,
            playlistNames: s.playlistNames,
            autoCloseDays: s.autoCloseDays,
            caps: s.caps as unknown as { maxItemsPerBatch: number; ingestPerHour: number; ingestSpacingS: number } & Record<string, number>,
            rights: s.rights,
            inviteUrl: s.inviteUrl,
          }}
        />
        <details className="text-xs text-cream/60">
          <summary className="cursor-pointer hover:text-cream">Stored settings (raw)</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-cream/50">
                  <th className="py-1 pr-3">Key</th>
                  <th className="py-1 pr-3">Value</th>
                  <th className="py-1">Updated</th>
                </tr>
              </thead>
              <tbody>
                {o.settings.map((r) => (
                  <tr key={r.key} className="border-t border-cream/10 align-top">
                    <td className="py-1 pr-3 font-mono">{r.key}</td>
                    <td className="max-w-md break-all py-1 pr-3 font-mono">{JSON.stringify(r.value)}</td>
                    <td className="py-1">
                      {when(r.updatedAt)}
                      {r.updatedBy ? ` by ${r.updatedBy}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="card space-y-3" aria-labelledby="roles-h">
        <h2 id="roles-h" className="text-lg font-bold">
          Reviewer roles
        </h2>
        <p className="text-sm text-cream/65">
          Discord roles that grant review or manage access. Admin access comes only from the portal owner list on the server.
        </p>
        <RoleBindings bindings={o.bindings} />
      </section>
    </section>
  )
}

function Stat({ label, value, bad = false }: { label: string; value: number | string; bad?: boolean }) {
  return (
    <div className="rounded-xl border border-cream/10 bg-cream/[0.03] p-3">
      <dt className="text-xs text-cream/55">{label}</dt>
      <dd className={`text-xl font-bold ${bad ? 'text-rose-300' : ''}`}>{value}</dd>
    </div>
  )
}
