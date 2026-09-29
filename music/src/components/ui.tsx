// Presentational building blocks with no client state (usable from server
// and client components alike).

import { BATCH_STATUS, FETCH_STAGE_STATUS, ITEM_STATUS, REQUEST_STATUS, type ChipTone } from './messages'

const TONE: Record<ChipTone, string> = {
  neutral: 'chip-neutral',
  pending: 'chip-pending',
  progress: 'chip-progress',
  live: 'chip-live',
  bad: 'chip-bad',
  muted: 'chip-muted',
}

export function Chip({ tone, children, title }: { tone: ChipTone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`chip ${TONE[tone]}`} title={title}>
      {children}
    </span>
  )
}

// v0.4.1: pass the item's source and fetch_stage and a SoundCloud link that
// is still 'probing' shows where it is instead of "Checking file".
export function ItemStatusChip({ status, source, fetchStage }: { status: string; source?: string | null; fetchStage?: string | null }) {
  const stage = status === 'probing' && source === 'soundcloud' ? FETCH_STAGE_STATUS[fetchStage ?? 'queued'] : undefined
  const s = stage ? { ...stage, tone: 'progress' as const } : (ITEM_STATUS[status] ?? { label: status, tone: 'neutral' as const, help: '' })
  return (
    <Chip tone={s.tone} title={s.help}>
      <span data-status={status}>{s.label}</span>
    </Chip>
  )
}

export function BatchStatusChip({ status }: { status: string }) {
  const s = BATCH_STATUS[status] ?? { label: status, tone: 'neutral' as const }
  return <Chip tone={s.tone}>{s.label}</Chip>
}

export function RequestStatusChip({ status }: { status: string }) {
  const s = REQUEST_STATUS[status] ?? { label: status, tone: 'neutral' as const }
  return <Chip tone={s.tone}>{s.label}</Chip>
}

export function NewArtistBadge() {
  return <span className="chip chip-new">NEW ARTIST</span>
}

export function StaffBadge() {
  return <span className="chip chip-staff">Staff only</span>
}

type Ticket = { number: number | null; webUrl: string | null; channelUrl?: string | null; status?: string | null } | null

// Only https links from the ticket record are rendered as links.
function safeHref(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    return new URL(u).protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

export function TicketLink({ ticket, empty = 'No ticket yet' }: { ticket: Ticket; empty?: string }) {
  if (!ticket) return <span className="text-xs text-cream/50">{empty}</span>
  const web = safeHref(ticket.webUrl)
  const discord = safeHref(ticket.channelUrl)
  const label = `Ticket #${ticket.number ?? '?'}`
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      {web ? (
        <a className="link" href={web} target="_blank" rel="noopener noreferrer">
          {label} ↗
        </a>
      ) : (
        <span>{label}</span>
      )}
      {discord ? (
        <a className="link text-xs" href={discord} target="_blank" rel="noopener noreferrer">
          Open in Discord ↗
        </a>
      ) : null}
      {ticket.status ? <span className="text-xs text-cream/50">({ticket.status})</span> : null}
    </span>
  )
}

export function Notice({ tone, children, id }: { tone: 'error' | 'warn' | 'ok' | 'info'; children: React.ReactNode; id?: string }) {
  return (
    <div id={id} className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function PageTitle({ title, sub, actions }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-sunburst">{title}</h1>
        {sub ? <p className="mt-1 text-sm text-cream/70">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}
