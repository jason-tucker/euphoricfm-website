// Portal home information sections ("Radio-first" portal home): what the
// portal is, who can submit, the four steps and song statuses, files and
// limits, the rights statement, edits and removals, the FAQ and links back
// to the station. Server components, no client state, no inline styles.
// Every size / length / format figure comes from uploadLimitsForUi().

import Link from 'next/link'
import { signInToRequestRemoval, signInToSuggestEdit, signInWithDiscord } from '@/app/actions'
import type { UiUploadLimits } from '@/server/ui/limits'
import { ItemStatusChip } from '../ui'
import { SITE_LINKS } from '../site-links'
import { faqEntries, type FaqEntry } from './faq'

export type HomeInfoData = {
  limits: UiUploadLimits
  rights: { version: string; text: string }
  requestCaps: { edit: number; removal: number }
  autoCloseDays: number
  inviteUrl: string
}

// The statuses a song shows in My music, in the order it moves through them
// (ITEM_STATUS in messages.ts), then the one alternative ending.
export const STATUS_PATH = ['pending', 'approved', 'applying', 'verifying', 'live'] as const

export function DiscordMark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`${className} fill-current`}>
      <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.8-9.7-3.6-13.7ZM8 15.4c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.6 8 10.6s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
    </svg>
  )
}

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 size-4 shrink-0 text-sunburst">
      <path d="m5 12 5 5 9-10" />
    </svg>
  )
}

function Cross() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mt-0.5 size-4 shrink-0 text-rose-300">
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6m0-6-6 6" />
    </svg>
  )
}

function SectionHead({ id, eyebrow, title, sub }: { id: string; eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="mb-4">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id} className="mt-1 text-2xl font-bold sm:text-3xl">
        {title}
      </h2>
      {sub ? <p className="mt-2 max-w-2xl text-sm text-cream/70">{sub}</p> : null}
    </div>
  )
}

function Facts({ rows, testId }: { rows: [string, string][]; testId?: string }) {
  return (
    <dl className="facts" data-testid={testId}>
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

// ------------------------------------------------------------ signed out --

export function Hero({ inviteUrl }: { inviteUrl: string }) {
  return (
    <div className="card hero-card space-y-4 sm:p-8">
      <p className="eyebrow">EuphoricFM Music Portal</p>
      <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
        Get your music on <span className="text-sunburst">Euphoric</span>
        <span className="text-ruby">FM</span>
      </h1>
      <p className="max-w-2xl text-cream/80">
        This is where artists send songs to the station. Upload your tracks, follow each one through review, and talk to the managers in Discord, all in one place.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <form action={signInWithDiscord}>
          <button type="submit" className="btn btn-primary px-6 text-base">
            <DiscordMark /> Sign in with Discord
          </button>
        </form>
        <a href="#how-h" className="btn btn-secondary">
          How it works <span aria-hidden="true">↓</span>
        </a>
      </div>
      <p className="text-xs text-cream/60">
        For members of the EuphoricFM Discord. Not in yet?{' '}
        <a href={inviteUrl} className="link" rel="noopener noreferrer" target="_blank">
          Join the Discord
        </a>
      </p>
    </div>
  )
}

export function AtAGlance({ limits }: { limits: UiUploadLimits }) {
  const items = [
    `${limits.text.formats}, ${limits.text.batchShort} at a time`,
    'A manager listens to every song',
    'Your own Discord ticket for each batch',
    'Approved songs go into rotation on the station',
  ]
  return (
    <section aria-labelledby="glance-h" className="card" data-testid="at-a-glance">
      <h2 id="glance-h" className="text-lg font-semibold">
        At a glance
      </h2>
      <ul className="mt-3 divide-y divide-cream/10 text-sm text-cream/85">
        {items.map((t) => (
          <li key={t} className="flex gap-2 py-2.5">
            <Check />
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function WhoAndNeeds() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section aria-labelledby="who-h" className="card">
        <h2 id="who-h" className="text-lg font-semibold">
          Who can submit
        </h2>
        <p className="mt-2 text-sm text-cream/75">
          Members of the EuphoricFM Discord who have finished membership screening. Signing in only lets us see your Discord name, whether you are in our server and your roles there. It can’t read your messages.
        </p>
        <p className="mt-2 text-sm text-cream/75">Still pending? Finish screening in Discord, then sign in again.</p>
      </section>
      <section aria-labelledby="need-h" className="card">
        <h2 id="need-h" className="text-lg font-semibold">
          What you’ll need
        </h2>
        <ul className="mt-2 space-y-2 text-sm text-cream/85">
          <li className="flex gap-2">
            <Check /> Your finished song as an MP3 or WAV
          </li>
          <li className="flex gap-2">
            <Check /> Cover art (optional: we read it from the file, or you can add one)
          </li>
          <li className="flex gap-2">
            <Check /> The rights to have it played on the radio
          </li>
        </ul>
      </section>
    </div>
  )
}

export function StatusLegend() {
  return (
    <div className="card flex flex-wrap items-center gap-2 py-3 text-sm sm:py-3" data-testid="status-legend">
      <span className="font-semibold text-cream/80">Song status:</span>
      {STATUS_PATH.map((s, i) => (
        <span key={s} className="inline-flex items-center gap-2">
          <ItemStatusChip status={s} />
          {i < STATUS_PATH.length - 1 ? (
            <span aria-hidden="true" className="text-cream/40">
              ›
            </span>
          ) : null}
        </span>
      ))}
      <span className="text-cream/55">or</span>
      <ItemStatusChip status="denied" />
      <span className="text-xs text-cream/55">(always with a reason)</span>
    </div>
  )
}

export function Timeline({ limits }: { limits: UiUploadLimits }) {
  const steps = [
    { t: 'Sign in with Discord', d: 'The portal is for members of the EuphoricFM Discord. Signing in checks that you’re in the server.' },
    {
      t: 'Upload your songs',
      d: `Drop in ${limits.text.batchShort} as MP3s or WAVs. We read the title, artist and cover art for you, and you can fix anything before you send.`,
    },
    { t: 'Managers review', d: 'Each batch opens a ticket in Discord. Managers listen, ask questions there, then approve or decline each song, with a reason if declined.' },
    { t: 'On air', d: 'Approved songs are added to the station a few at a time and go into rotation. Follow every song in My music.' },
  ]
  return (
    <section aria-labelledby="how-h" className="scroll-mt-6">
      <SectionHead id="how-h" eyebrow="How it works" title="From upload to on air" sub="Four steps. You can follow every song the whole way, and you’ll hear from the managers in your Discord ticket." />
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="steps">
        {steps.map((s, i) => (
          <li key={s.t} className="card">
            <span className="step-num" aria-hidden="true">
              {i + 1}
            </span>
            <h3 className="mt-3 font-semibold">
              <span className="sr-only">Step {i + 1}: </span>
              {s.t}
            </h3>
            <p className="mt-1 text-sm text-cream/70">{s.d}</p>
          </li>
        ))}
      </ol>
      <div className="mt-3">
        <StatusLegend />
      </div>
    </section>
  )
}

export function CantTake({ limits }: { limits: UiUploadLimits }) {
  const items = [
    `${limits.text.refusedFormats}. Export an MP3 or WAV first.`,
    `Files or songs outside the limits: ${limits.text.tooLong}`,
    `MP3s under ${limits.minKbps} kbps.`,
    'Music you don’t own or don’t have permission to share.',
  ]
  return (
    <section aria-labelledby="cant-h" className="card" data-testid="cant-take">
      <h3 id="cant-h" className="font-semibold">
        We can’t take
      </h3>
      <ul className="mt-3 space-y-2 text-sm text-cream/80">
        {items.map((t) => (
          <li key={t} className="flex gap-2">
            <Cross />
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function RightsBox({ rights }: { rights: { version: string; text: string } }) {
  return (
    <section aria-labelledby="rights-h" className="card rights-card">
      <h3 id="rights-h" className="font-semibold">
        Your rights, in your words
      </h3>
      <p className="mt-1 text-xs text-cream/60">Every submission asks you to confirm this:</p>
      <blockquote className="rights-quote mt-3" data-testid="rights-text" data-version={rights.version}>
        {rights.text}
      </blockquote>
    </section>
  )
}

export function FilesAndLimits({ limits, rights }: { limits: UiUploadLimits; rights: { version: string; text: string } }) {
  const t = limits.text
  return (
    <section aria-labelledby="accept-h" className="scroll-mt-6">
      <SectionHead id="accept-h" eyebrow="What we accept" title="Files, sizes and rights" />
      <div className="grid gap-3 md:grid-cols-3" data-testid="limits">
        <section aria-labelledby="mp3-h" className="card">
          <h3 id="mp3-h" className="font-semibold">
            MP3
          </h3>
          <Facts
            testId="limits-mp3"
            rows={[
              ['Size', t.mp3Size],
              ['Quality', t.mp3Quality],
              ['Length', t.mp3Length],
              ['Tags', t.mp3Tags],
            ]}
          />
        </section>
        <section aria-labelledby="wav-h" className="card">
          <h3 id="wav-h" className="font-semibold">
            WAV
          </h3>
          <Facts
            testId="limits-wav"
            rows={[
              ['Size', t.wavSize],
              ['Format', t.wavFormat],
              ['Length', t.wavLength],
              ['We do', t.wavConvert],
            ]}
          />
        </section>
        <section aria-labelledby="art-h" className="card">
          <h3 id="art-h" className="font-semibold">
            Cover art
          </h3>
          <Facts
            testId="limits-art"
            rows={[
              ['Files', t.artFormats],
              ['Size', t.artSize],
              ['Or', 'we use the art inside your file'],
              ['Batch', t.batch],
            ]}
          />
        </section>
      </div>
      <p className="mt-2 text-xs text-cream/60" data-testid="limits-note">
        {limits.note}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <CantTake limits={limits} />
        <RightsBox rights={rights} />
      </div>
    </section>
  )
}

export function EditsAndRemovals({ requestCaps, signedIn }: { requestCaps: { edit: number; removal: number }; signedIn: boolean }) {
  return (
    <section aria-labelledby="edits-h" className="scroll-mt-6">
      <SectionHead id="edits-h" eyebrow="Already on air?" title="Edits and removals" />
      <div className="grid gap-3 md:grid-cols-2">
        <section aria-labelledby="fix-h" className="card flex flex-col gap-3">
          <h3 id="fix-h" className="font-semibold">
            Fix a song’s info or cover
          </h3>
          <p className="text-sm text-cream/75">
            Spotted a typo or an old cover? Find the song in the Library and choose <strong className="text-cream">Suggest edit</strong>. You can change the title, artist, album, genre or cover art. A
            manager checks it, then the station updates.
          </p>
          {signedIn ? (
            <Link href="/library?intent=edit" className="btn btn-secondary mt-auto self-start">
              Find the song <span aria-hidden="true">›</span>
            </Link>
          ) : (
            <form action={signInToSuggestEdit} className="mt-auto">
              <button type="submit" className="btn btn-secondary">
                Sign in to suggest an edit
              </button>
            </form>
          )}
        </section>
        <section aria-labelledby="remove-h" className="card flex flex-col gap-3">
          <h3 id="remove-h" className="font-semibold">
            Ask to remove a song
          </h3>
          <p className="text-sm text-cream/75">
            Want a song off the station? Find it in the Library and choose <strong className="text-cream">Request removal</strong>, with a short reason. Managers decide and reply in your
            Discord ticket.
          </p>
          {signedIn ? (
            <Link href="/library?intent=remove" className="btn btn-secondary mt-auto self-start">
              Find the song <span aria-hidden="true">›</span>
            </Link>
          ) : (
            <form action={signInToRequestRemoval} className="mt-auto">
              <button type="submit" className="btn btn-secondary">
                Sign in to request removal
              </button>
            </form>
          )}
        </section>
      </div>
      <p className="mt-2 text-xs text-cream/60" data-testid="request-caps">
        One open edit and one open removal request per song · up to {requestCaps.edit} edit and {requestCaps.removal} removal requests a day · follow them under My music.
      </p>
    </section>
  )
}

export function Faq({ entries }: { entries: FaqEntry[] }) {
  const half = Math.ceil(entries.length / 2)
  const col = (list: FaqEntry[]) => (
    <div className="space-y-3">
      {list.map((e) => (
        <details key={e.id} className="faq" data-faq={e.id}>
          <summary>{e.q}</summary>
          <p className="px-4 pb-4 text-sm text-cream/75">{e.a}</p>
        </details>
      ))}
    </div>
  )
  return (
    <section aria-labelledby="faq-h" className="scroll-mt-6" data-testid="faq">
      <SectionHead id="faq-h" eyebrow="FAQ" title="Questions artists ask" />
      <div className="grid items-start gap-3 md:grid-cols-2">
        {col(entries.slice(0, half))}
        {col(entries.slice(half))}
      </div>
    </section>
  )
}

export function MoreLinks({ inviteUrl }: { inviteUrl: string }) {
  return (
    <section aria-labelledby="more-h">
      <p className="eyebrow">More from EuphoricFM</p>
      <h2 id="more-h" className="sr-only">
        More from EuphoricFM
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <a href={SITE_LINKS.listen} className="row-link px-4 py-4" data-testid="listen-live">
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-cream">Listen live</span>
            <span className="block text-sm text-cream/65">EuphoricFM home, now playing and requests</span>
          </span>
        </a>
        <a href={inviteUrl} className="btn btn-discord min-h-[64px] text-base" rel="noopener noreferrer" target="_blank" data-testid="discord-invite">
          <DiscordMark /> Join our Discord
        </a>
      </div>
    </section>
  )
}

// -------------------------------------------------------------- signed in --

export function BeforeYouUpload({ limits }: { limits: UiUploadLimits }) {
  const t = limits.text
  return (
    <section aria-labelledby="before-h" className="card" data-testid="before-you-upload">
      <h2 id="before-h" className="text-lg font-semibold">
        Before you upload
      </h2>
      <Facts
        testId="limits-short"
        rows={[
          ['MP3', t.mp3Short],
          ['WAV', t.wavShort],
          ['Cover', t.artShort],
          ['Batch', t.batchShort],
          ['Not', t.refusedShort],
        ]}
      />
      <p className="mt-3 text-xs text-cream/60">{limits.note}</p>
    </section>
  )
}

export function AfterYouSubmit() {
  const steps = [
    { t: 'A ticket opens in Discord', d: 'Managers talk to you there' },
    { t: 'Each song is approved or declined', d: 'Declines always come with a reason' },
    { t: 'Approved songs go on air', d: 'Added to the station a few at a time' },
  ]
  return (
    <section aria-labelledby="after-h" className="card" data-testid="how-it-works">
      <h2 id="after-h" className="text-lg font-semibold">
        After you submit
      </h2>
      <ol className="mt-3 space-y-3">
        {steps.map((s, i) => (
          <li key={s.t} className="flex gap-3">
            <span className="step-num step-num-sm" aria-hidden="true">
              {i + 1}
            </span>
            <span className="text-sm">
              <span className="block font-medium text-cream">{s.t}</span>
              <span className="block text-cream/60">{s.d}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function ChangingASong({ requestCaps }: { requestCaps: { edit: number; removal: number } }) {
  return (
    <section aria-labelledby="changing-h" className="card" data-testid="changing-a-song">
      <h2 id="changing-h" className="text-lg font-semibold">
        Changing a song on air
      </h2>
      <p className="mt-2 text-sm text-cream/75">Use Fix a song’s info or Ask to remove a song above. Managers check every request.</p>
      <Facts
        rows={[
          ['Open', 'one edit and one removal request per song'],
          ['Daily', `${requestCaps.edit} edits and ${requestCaps.removal} removals`],
          ['Track', 'under My music'],
        ]}
      />
    </section>
  )
}

// ----------------------------------------------------------- whole pages --

export function SignedOutInfo({ data }: { data: HomeInfoData }) {
  return (
    <div className="space-y-10 sm:space-y-12">
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Hero inviteUrl={data.inviteUrl} />
        <AtAGlance limits={data.limits} />
      </div>
      <WhoAndNeeds />
      <Timeline limits={data.limits} />
      <FilesAndLimits limits={data.limits} rights={data.rights} />
      <EditsAndRemovals requestCaps={data.requestCaps} signedIn={false} />
      <Faq entries={faqEntries(data)} />
      <MoreLinks inviteUrl={data.inviteUrl} />
    </div>
  )
}

export function SignedInInfo({ data }: { data: HomeInfoData }) {
  return (
    <div className="space-y-10">
      <div className="grid gap-3 md:grid-cols-3">
        <BeforeYouUpload limits={data.limits} />
        <AfterYouSubmit />
        <ChangingASong requestCaps={data.requestCaps} />
      </div>
      <StatusLegend />
      <Faq entries={faqEntries(data)} />
      <MoreLinks inviteUrl={data.inviteUrl} />
    </div>
  )
}
