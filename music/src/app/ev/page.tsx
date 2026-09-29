import { EV_COPY } from '@/events/components/copy'
import { ListenCard, MemberRules, UpcomingPublic } from '@/events/components/HomeParts'
import { RequestCta } from './RequestCta'
import { evViewer } from './viewer'

export const dynamic = 'force-dynamic'

export default async function EventsHome() {
  const viewer = await evViewer()
  const h = EV_COPY.hero
  return (
    <div className="space-y-10">
      <section className="card hero-card space-y-4" aria-labelledby="ev-hero-h">
        <p className="eyebrow">{h.eyebrow}</p>
        <h1 id="ev-hero-h" className="text-3xl font-bold leading-tight text-cream sm:text-4xl">
          {h.heading}
        </h1>
        <p className="max-w-2xl text-cream/85">{h.body}</p>
        <div className="flex flex-wrap gap-3">
          <RequestCta signedIn={!!viewer} />
          <a className="btn btn-secondary" href="/how-it-works">
            {h.ctaHow}
          </a>
          <a className="btn btn-secondary" href="/listen">
            {h.ctaListen}
          </a>
        </div>
        {viewer ? null : <p className="text-xs text-cream/60">You need to be a member of the EuphoricFM Discord server to request an event.</p>}
      </section>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <UpcomingPublic />
        <div className="space-y-3">
          <ListenCard />
          <a href="/calendar" className="action-card">
            <span className="eyebrow">Calendar</span>
            <span className="text-lg font-bold text-cream">See what&apos;s booked</span>
            <span className="text-sm text-cream/75">Month view or list, in Eastern time or yours.</span>
            <span className="action-cue">Open the calendar ›</span>
          </a>
        </div>
      </div>

      <section aria-labelledby="ev-how-h" className="space-y-4">
        <h2 id="ev-how-h" className="text-2xl font-bold text-sunburst">
          {EV_COPY.howItWorks.title}
        </h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {EV_COPY.howItWorks.steps.map((s) => (
            <li key={s.n} className="card space-y-2">
              <span className="step-num">{s.n}</span>
              <h3 className="font-bold text-cream">{s.title}</h3>
              <p className="text-sm text-cream/80">{s.body}</p>
            </li>
          ))}
        </ol>
        <a className="btn btn-secondary" href="/how-it-works">
          Step-by-step tutorial ›
        </a>
      </section>

      <section aria-labelledby="ev-svc-h" className="space-y-4">
        <h2 id="ev-svc-h" className="text-2xl font-bold text-sunburst">
          {EV_COPY.services.title}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {EV_COPY.services.items.map((s) => (
            <li key={s.title} className="card space-y-1">
              <h3 className="font-bold text-cream">{s.title}</h3>
              <p className="text-sm text-cream/80">{s.body}</p>
            </li>
          ))}
        </ul>
        <div className="space-y-2">
          <h3 className="text-sm font-bold uppercase tracking-[0.15em] text-cream/70">{EV_COPY.goodFor.title}</h3>
          <ul className="ev-chips">
            {EV_COPY.goodFor.items.map((g) => (
              <li key={g} className="ev-tag">
                {g}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="ev-site-h" className="space-y-4">
        <h2 id="ev-site-h" className="text-2xl font-bold text-sunburst">
          {EV_COPY.site.title}
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          {EV_COPY.site.items.map((s) => (
            <div key={s.title} className="card">
              <dt className="font-bold text-cream">{s.title}</dt>
              <dd className="mt-1 text-sm text-cream/80">{s.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <MemberRules />

      <section className="card rights-card flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-cream">Ready to plan yours?</h2>
          <p className="text-sm text-cream/80">It takes about ten minutes. You can save a draft and finish later.</p>
        </div>
        <RequestCta signedIn={!!viewer} />
      </section>
    </div>
  )
}
