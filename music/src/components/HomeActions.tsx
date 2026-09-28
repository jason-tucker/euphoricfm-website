// The member's three primary actions (submit, fix a song, ask for removal),
// as large cards on the home page and a compact bar on My music, plus the
// My music / review-queue summary cards. No client state.

import Link from 'next/link'

export type RequestIntent = 'edit' | 'remove'

export function parseIntent(v: unknown): RequestIntent | null {
  return v === 'edit' || v === 'remove' ? v : null
}

// Song page URL with the matching request form opened.
export function requestHref(mediaId: number, intent: RequestIntent) {
  return `/library/${mediaId}?request=${intent}#request-form`
}

type Action = { key: 'submit' | RequestIntent; href: string; title: string; short: string; desc: string; perm: 'submit' | 'request' }

export const ACTIONS: readonly Action[] = [
  {
    key: 'submit',
    href: '/submit',
    title: 'Submit new songs',
    short: 'Submit songs',
    desc: 'Upload MP3 or WAV files. We read the tags and cover art for you.',
    perm: 'submit',
  },
  {
    key: 'edit',
    href: '/library?intent=edit',
    title: 'Fix a song’s info or cover',
    short: 'Fix a song’s info',
    desc: 'Find a song on the station and suggest a new title, artist, album or cover art.',
    perm: 'request',
  },
  {
    key: 'remove',
    href: '/library?intent=remove',
    title: 'Ask to remove a song',
    short: 'Ask to remove a song',
    desc: 'Find a song and tell the managers why it should come off the station.',
    perm: 'request',
  },
]

const actionsFor = (perms: ReadonlySet<string>) => ACTIONS.filter((a) => perms.has(a.perm))

export function ActionIcon({ name, className = 'size-6' }: { name: Action['key']; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {name === 'submit' ? (
        <>
          <path d="M12 16V4" />
          <path d="m7 9 5-5 5 5" />
          <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
        </>
      ) : name === 'edit' ? (
        <>
          <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
          <path d="m13.5 6.5 4 4" />
        </>
      ) : (
        <>
          <path d="M4 7h16" />
          <path d="M10 11v6M14 11v6" />
          <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
          <path d="M9 7V4h6v3" />
        </>
      )}
    </svg>
  )
}

// Home page: "What do you want to do?" — one column on phones, three on desktop.
export function ActionCards({ perms }: { perms: ReadonlySet<string> }) {
  const list = actionsFor(perms)
  if (list.length === 0) return null
  return (
    <ul className="grid gap-3 md:grid-cols-3" data-testid="action-cards">
      {list.map((a) => (
        <li key={a.key} className="flex">
          <Link href={a.href} className={`action-card ${a.key === 'submit' ? 'action-card-primary' : ''}`} data-action={a.key}>
            <span className={`action-icon ${a.key === 'remove' ? 'text-rose-300' : 'text-sunburst'}`}>
              <ActionIcon name={a.key} />
            </span>
            <h3 className="text-lg font-bold text-cream">{a.title}</h3>
            <p className="text-sm text-cream/70">{a.desc}</p>
            <span className="action-cue" aria-hidden="true">
              {a.key === 'submit' ? 'Start uploading' : 'Find the song'} <span className="text-lg leading-none">›</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// My music: the same three actions as a compact button bar.
export function ActionBar({ perms }: { perms: ReadonlySet<string> }) {
  return (
    <nav aria-label="Actions" className="flex flex-wrap gap-2" data-testid="action-bar">
      {actionsFor(perms).map((a) => (
        <Link key={a.key} href={a.href} className={`btn ${a.key === 'submit' ? 'btn-primary' : 'btn-secondary'}`} data-action={a.key}>
          <ActionIcon name={a.key} className="size-4" />
          {a.short}
        </Link>
      ))}
    </nav>
  )
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function summaryText(s: { inReview: number; onAir: number; openRequests: number }) {
  return `${s.inReview} in review · ${s.onAir} on air · ${plural(s.openRequests, 'open request')}`
}

export function MyMusicCard({ summary }: { summary: { inReview: number; onAir: number; openRequests: number } }) {
  return (
    <Link
      href="/dashboard"
      className="row-link px-4 py-4"
      data-testid="my-music-card"
      data-count-in-review={summary.inReview}
      data-count-on-air={summary.onAir}
      data-count-open-requests={summary.openRequests}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-cream">My music</span>
        <span className="block text-sm text-cream/70">{summaryText(summary)}</span>
      </span>
    </Link>
  )
}

export function ReviewQueueCard({ summary }: { summary: { songs: number; requests: number } }) {
  const waiting = summary.songs + summary.requests > 0
  // Land on the requests tab when only requests are waiting (the songs tab
  // would be empty); otherwise the songs tab, which links to requests.
  const href = summary.songs === 0 && summary.requests > 0 ? '/review/requests' : '/review'
  return (
    <Link
      href={href}
      className="row-link border-sunburst/50 bg-sunburst/[0.08] px-4 py-4"
      data-testid="review-card"
      data-count-songs={summary.songs}
      data-count-requests={summary.requests}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-sunburst">Review queue</span>
        <span className="block text-sm text-cream/80">
          {waiting ? `${plural(summary.songs, 'song')} and ${plural(summary.requests, 'request')} waiting` : 'Nothing waiting right now'}
        </span>
      </span>
    </Link>
  )
}
