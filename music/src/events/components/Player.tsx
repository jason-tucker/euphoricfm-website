'use client'

// EuphoricFM Event Radio player: a React port of the info Web Player for the
// Event station. Live stream (no seeking): play sets src to the stream plus a
// ?t= cache-buster (always the live edge), stop clears src so the connection
// is released. When the station is idle it plays the EFM Events loop, so the
// player always plays; the card says so.

import { useCallback, useEffect, useRef, useState } from 'react'
import { EV_COPY } from './copy'
import { formatLength } from './time'
import { type NowPlaying, songLine, useNowPlaying } from './nowplaying'

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
    </svg>
  )
}

/** Seconds into the current song, advanced locally between polls. */
export function elapsedNow(np: NowPlaying | null, loadedAt: number, now: number): { elapsed: number; duration: number } {
  const e = np?.now_playing
  const duration = Math.max(0, e?.duration ?? 0)
  const base = e?.elapsed ?? 0
  const elapsed = Math.min(duration || Infinity, base + Math.max(0, (now - loadedAt) / 1000))
  return { elapsed: Number.isFinite(elapsed) ? elapsed : 0, duration }
}

function setMediaSession(title: string, artist: string, art: string | undefined) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'EuphoricFM Event Radio',
      artist: artist || 'EuphoricFM Events',
      album: 'EuphoricFM Event Radio',
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
    })
  } catch {
    // unsupported
  }
}

export function Player({ streamUrl, nowPlayingUrl, compact = false }: { streamUrl: string; nowPlayingUrl: string; compact?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [volume, setVolume] = useState(0.9)
  const [now, setNow] = useState(() => Date.now())
  const { data, failures, loadedAt } = useNowPlaying(nowPlayingUrl)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (audio.current) audio.current.volume = volume
  }, [volume])

  const stop = useCallback(() => {
    const a = audio.current
    if (!a) return
    a.pause()
    a.removeAttribute('src')
    a.load()
    setPlaying(false)
  }, [])

  const play = useCallback(async () => {
    const a = audio.current
    if (!a) return
    setErr(null)
    setBusy(true)
    try {
      a.src = `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}t=${Date.now()}`
      await a.play()
      setPlaying(true)
    } catch (e) {
      if ((e as { name?: string } | null)?.name !== 'AbortError') {
        stop()
        setErr("Couldn't start the stream. Check your connection and press play again.")
      }
    } finally {
      setBusy(false)
    }
  }, [streamUrl, stop])

  const toggle = () => (playing ? stop() : void play())

  const line = songLine(data?.now_playing)
  const art = data?.now_playing?.song?.art
  useEffect(() => {
    if (playing) setMediaSession(line.title, line.artist, art)
  }, [playing, line.title, line.artist, art])

  // Now-playing unreachable (network, CORS) says nothing about the stream,
  // which may well be playing the Events loop: stay neutral. OFF AIR only
  // when the station itself reports is_online === false.
  const unavailable = failures >= (data ? 2 : 1)
  const offAir = !unavailable && data?.is_online === false
  const { elapsed, duration } = elapsedNow(data, loadedAt, now)
  const history = (data?.song_history ?? []).slice(0, compact ? 0 : 5)
  const next = data?.playing_next ? songLine(data.playing_next) : null

  return (
    <section className="card ev-player space-y-4" aria-label="EuphoricFM Event Radio player">
      <audio
        ref={audio}
        preload="none"
        onEnded={() => setPlaying(false)}
        onError={() => {
          if (audio.current?.getAttribute('src')) {
            setPlaying(false)
            setErr('The stream stopped. Press play to reconnect.')
          }
        }}
      />
      <div className="flex items-start gap-4">
        {art ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={art} alt="" className="ev-player-art" />
        ) : (
          <div className="ev-player-art" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {unavailable ? null : (
              <span className="ev-onair" data-on={offAir ? 'false' : 'true'}>
                {offAir ? 'OFF AIR' : 'ON AIR'}
              </span>
            )}
            <span className="text-xs text-cream/60">EuphoricFM Event Radio</span>
          </div>
          <p className="truncate text-lg font-bold text-cream" data-testid="np-title">
            {unavailable ? 'Now playing unavailable' : line.title || (data ? 'EuphoricFM Events' : 'Loading…')}
          </p>
          {line.artist && !unavailable ? <p className="truncate text-sm text-cream/75">{line.artist}</p> : null}
          {duration > 0 && !unavailable ? (
            <div className="flex items-center gap-2 text-xs text-cream/60">
              <span>{formatLength(elapsed)}</span>
              <progress className="progress" max={duration} value={Math.min(elapsed, duration)} aria-label="Song progress" />
              <span>{formatLength(duration)}</span>
            </div>
          ) : null}
        </div>
      </div>

      {offAir ? (
        <p className="notice notice-info" role="status">
          {EV_COPY.offAir}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <button type="button" className="ev-play" onClick={toggle} disabled={busy} aria-label={playing ? 'Stop' : 'Play Event Radio'} aria-pressed={playing}>
          <PlayIcon playing={playing} />
        </button>
        <label className="flex min-w-[10rem] flex-1 items-center gap-2 text-xs text-cream/70">
          <span>Volume</span>
          <input className="ev-range" type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" />
        </label>
        {typeof data?.listeners?.current === 'number' ? (
          <span className="text-xs text-cream/60">
            {data.listeners.current} listening
          </span>
        ) : null}
      </div>
      {err ? (
        <p className="notice notice-error" role="alert">
          {err}
        </p>
      ) : null}

      {!compact && next && next.title ? (
        <p className="text-sm text-cream/70">
          <span className="font-semibold text-cream/85">Up next:</span> {next.artist ? `${next.artist} – ` : ''}
          {next.title}
        </p>
      ) : null}
      {history.length ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-cream/85">Recently played</h2>
          <ol className="space-y-1 text-sm text-cream/70">
            {history.map((h, i) => {
              const l = songLine(h)
              return (
                <li key={`${h.played_at ?? i}-${i}`} className="truncate">
                  {l.artist ? `${l.artist} – ` : ''}
                  {l.title || 'EuphoricFM'}
                </li>
              )
            })}
          </ol>
        </div>
      ) : null}
    </section>
  )
}
