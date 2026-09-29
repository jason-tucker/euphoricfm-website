import { MemberRules } from '@/events/components/HomeParts'
import { EV_COPY } from '@/events/components/copy'
import { RequestCta } from '../RequestCta'
import { evViewer } from '../viewer'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'How it works' }

// Each step is illustrated with a small CSS mock of the screen (no images).
function Mock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ev-mock" aria-hidden="true">
      <div className="ev-mock-bar">
        <i />
        <i />
        <i />
        <span>{title}</span>
      </div>
      {children}
    </div>
  )
}

type Step = { title: string; body: React.ReactNode; mock: React.ReactNode }

const STEPS: Step[] = [
  {
    title: 'Sign in with Discord',
    body: 'Press "Request an event" and sign in with your Discord account. You need to be a member of the EuphoricFM Discord server; that is where your ticket opens later.',
    mock: (
      <Mock title="events.euphoric.fm">
        <div className="ev-mock-line ev-w60" />
        <div className="ev-mock-line" />
        <span className="ev-mock-btn discord">Sign in with Discord</span>
      </Mock>
    ),
  },
  {
    title: 'Tell us about the event',
    body: 'Give it a title, say who is hosting and where, pick the kind of event and add a short description. Then choose the date, start time and length. The form checks the rules as you type: at least 24 hours of notice (with a warning under 48 hours), how long and how far ahead you can book, and whether the slot is free.',
    mock: (
      <Mock title="Request · Details">
        <div className="ev-mock-input">Grand opening at Vespucci Motors</div>
        <div className="ev-mock-input">Sat, Oct 18 · 8:00 PM ET · 3 h</div>
        <div className="ev-mock-row">
          Slot is free <b>✓</b>
        </div>
      </Mock>
    ),
  },
  {
    title: 'Pick public or private',
    body: 'Public events show their title, host, place and description on the calendar. Private events show only "Booked · Private event" and the time. Either way, the time slot is visible so nobody double-books it.',
    mock: (
      <Mock title="Request · Visibility">
        <div className="ev-mock-row">
          ◉ Public <b>on the calendar</b>
        </div>
        <div className="ev-mock-row">○ Private</div>
      </Mock>
    ),
  },
  {
    title: 'Build the playlist: songs',
    body: 'Search the EuphoricFM library and add songs. Play them in your order or shuffled. Reorder with the Up and Down buttons. You can pin a song to a time (on a 5-minute grid): it plays at the next song break after that time, so it never cuts another song off.',
    mock: (
      <Mock title="Request · Playlist">
        <div className="ev-mock-input">Search the library…</div>
        <div className="ev-mock-row">
          1. Opening anthem <b>pinned 8:00 PM</b>
        </div>
        <div className="ev-mock-row">2. Night drive</div>
        <div className="ev-mock-row">3. Neon skyline</div>
      </Mock>
    ),
  },
  {
    title: 'Build the playlist: announcements',
    body: 'Add announcements from the EuphoricFM announcement set, or your own recordings from My audio. Play one at a set time, or every 15, 20, 30 or 60 minutes between two times. Announcements cut in at their time, then the music carries on.',
    mock: (
      <Mock title="Request · Announcements">
        <div className="ev-mock-row">
          &quot;Welcome to the opening&quot; <b>at 8:05 PM</b>
        </div>
        <div className="ev-mock-row">
          &quot;Raffle at the stage&quot; <b>every 30 min</b>
        </div>
      </Mock>
    ),
  },
  {
    title: 'Upload your own audio (optional)',
    body: 'In My audio you can upload MP3 or WAV files: announcements or your own songs. We check each file, then keep it in your library so you can reuse it. You confirm you have the rights to it. Need a longer file than the limit? Ask in your ticket.',
    mock: (
      <Mock title="My audio">
        <div className="ev-mock-row">
          grand-opening-intro.mp3 <b>Ready</b>
        </div>
        <div className="ev-mock-row">
          sponsor-thanks.wav <b>Checking…</b>
        </div>
      </Mock>
    ),
  },
  {
    title: 'Review and submit',
    body: 'Check the summary: the time in Eastern and in your zone, the running length of your songs against the length of the event, and your announcements. Press Submit.',
    mock: (
      <Mock title="Request · Review">
        <div className="ev-mock-line" />
        <div className="ev-mock-line ev-w40" />
        <div className="ev-mock-row">
          Songs: 2 h 55 min <b>event 3 h</b>
        </div>
        <span className="ev-mock-btn">Submit request</span>
      </Mock>
    ),
  },
  {
    title: 'A ticket opens in Discord',
    body: 'Submitting opens a ticket for your event in the EuphoricFM Discord. The team can ask questions there, and the site posts every change to it. Your request shows as Pending on the calendar, holding the slot.',
    mock: (
      <Mock title="Discord · #event-request">
        <div className="ev-mock-chat">New event request: Grand opening, Sat Oct 18, 8:00 PM ET</div>
        <span className="ev-mock-pill gold">Pending</span>
      </Mock>
    ),
  },
  {
    title: 'Staff approve it',
    body: 'The team approves (or explains why not) in the ticket. Once approved, your event is set up on EuphoricFM Event Radio before it starts. If you change the title, songs, announcements, the time or the visibility after approval, it goes back for a quick re-approval; your slot stays held.',
    mock: (
      <Mock title="My events">
        <div className="ev-mock-row">
          Grand opening <b>Approved</b>
        </div>
        <span className="ev-mock-pill ok">Approved</span>
      </Mock>
    ),
  },
  {
    title: 'It airs, and you listen',
    body: 'At the start time your programming goes on air on Event Radio. Listen on this site, or set up EuphoricFM radios around your venue. The last song may run up to 90 seconds past the end.',
    mock: (
      <Mock title="Listen">
        <span className="ev-mock-pill live">ON AIR</span>
        <div className="ev-mock-line ev-w60" />
        <div className="ev-mock-line ev-w40" />
        <span className="ev-mock-btn">▶ Play</span>
      </Mock>
    ),
  },
]

const FAQ: { q: string; a: string }[] = [
  {
    q: 'What does a private event hide?',
    a: `On this site and in the calendar feed, a private event shows only "Booked · Private event" and its time: no title, host, place or description. ${EV_COPY.privateNowPlaying}`,
  },
  {
    q: 'Which time zone are times in?',
    a: 'Everything is shown in Eastern time (ET), the station’s time, unless you switch the "ET | Local" toggle at the top to your own time zone. Every time is labelled with its zone. In the request form you enter times in the zone you picked, and we show the other one as a hint.',
  },
  {
    q: 'What does "Pending" mean?',
    a: 'Pending means a request is waiting for the EuphoricFM team to review it. It still holds its time slot, so nobody else can book over it. If nobody acts on it, it expires 12 hours before its start time.',
  },
  {
    q: 'My file is longer or bigger than the limit. What now?',
    a: 'Ask in your ticket. The team can add longer files for you.',
  },
  {
    q: 'Will the music stop exactly at the end time?',
    a: 'Songs are never cut off, so the last song may run up to 90 seconds past the end of your event. Then Event Radio goes back to the EFM Events loop.',
  },
  {
    q: 'Why did my pinned song play a little late?',
    a: 'A pinned song waits for the song before it to finish, so it starts at the first song break after its time. Announcements are different: they cut in right on time.',
  },
  {
    q: 'Can I change my event after submitting?',
    a: 'Yes, from My events, until 30 minutes before it starts. Changing the description or host is instant; changing the title, songs, announcements, the time or the visibility of an approved event sends it back for a quick re-approval.',
  },
]

export default async function HowItWorks() {
  const viewer = await evViewer()
  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <p className="eyebrow">Tutorial</p>
        <h1 className="text-3xl font-bold text-cream">How EuphoricFM Events works</h1>
        <p className="max-w-2xl text-cream/80">From idea to on air in ten steps. Each step shows roughly what you will see.</p>
      </header>

      <ol className="space-y-6">
        {STEPS.map((s, i) => (
          <li key={s.title} className="card grid items-center gap-4 md:grid-cols-[1fr_auto]">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="step-num">{i + 1}</span>
                <h2 className="text-lg font-bold text-cream">{s.title}</h2>
              </div>
              <p className="text-sm leading-relaxed text-cream/85">{s.body}</p>
            </div>
            {s.mock}
          </li>
        ))}
      </ol>

      <MemberRules />

      <section aria-labelledby="ev-faq-h" className="space-y-3">
        <h2 id="ev-faq-h" className="text-2xl font-bold text-sunburst">
          Questions
        </h2>
        {FAQ.map((f) => (
          <details key={f.q} className="faq">
            <summary>{f.q}</summary>
            <p className="px-4 pb-4 text-sm leading-relaxed text-cream/85">{f.a}</p>
          </details>
        ))}
      </section>

      <div className="flex flex-wrap gap-3">
        <RequestCta signedIn={!!viewer} />
        <a className="btn btn-secondary" href="/calendar">
          See the calendar
        </a>
      </div>
    </div>
  )
}
