import { EV_COPY } from '@/events/components/copy'
import { evSignInToRequest } from './actions'

export function RequestCta({ signedIn, label = EV_COPY.hero.ctaRequest }: { signedIn: boolean; label?: string }) {
  return signedIn ? (
    <a className="btn btn-primary" href="/request">
      {label}
    </a>
  ) : (
    <form action={evSignInToRequest}>
      <button type="submit" className="btn btn-discord">
        {label}: sign in with Discord
      </button>
    </form>
  )
}
