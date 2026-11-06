// Web-side background sweep for /staging/uploads retention (hourly).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.MUSIC_DISABLE_SWEEPER === '1') return
  const { sweepStaging } = await import('./server/uploads/retention')
  const { sweepArt } = await import('./server/art/retention')
  const { getDb } = await import('./server/db/client')
  const dir = process.env.STAGING_UPLOADS_DIR ?? '/staging/uploads'
  const tick = async () => {
    try {
      const r = await sweepStaging(getDb(), dir)
      if (r.removed > 0) console.log(`[retention] removed ${r.removed} staged upload(s)`)
      const a = await sweepArt(getDb(), { spoolIn: process.env.SPOOL_PROBE_IN_DIR ?? '/spool/probe/in-web' })
      if (a.expired + a.timedOut > 0) console.log(`[retention] art: ${a.expired} expired, ${a.timedOut} timed out`)
    } catch (e) {
      console.error('[retention] sweep failed', e instanceof Error ? e.message : e)
    }
  }
  setTimeout(tick, 60_000).unref()
  setInterval(tick, 3600_000).unref()
}
