import { CurrentEvent } from '@/events/components/CurrentEvent'
import { Player } from '@/events/components/Player'
import { NOWPLAYING_URL, STATION_LISTEN_URL } from '@/events/contract/rules'

export const metadata = { title: 'Listen' }

export default function ListenPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2">
        <p className="eyebrow">Listen</p>
        <h1 className="text-3xl font-bold text-cream">EuphoricFM Event Radio</h1>
        <p className="text-sm text-cream/75">Events air here live. Between events the station plays the EFM Events loop, so there is always something on.</p>
      </header>
      <Player streamUrl={STATION_LISTEN_URL} nowPlayingUrl={NOWPLAYING_URL} />
      <CurrentEvent />
      <p className="text-xs text-cream/55">
        Want the main station instead?{' '}
        <a className="link" href="https://info.euphoric.fm/player/">
          Open the EuphoricFM Web Player
        </a>
      </p>
    </div>
  )
}
