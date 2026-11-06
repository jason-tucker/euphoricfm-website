// Worker alerts: stderr, plus the optional Kuma push (KUMA_PUSH_URL) and
// Discord webhook (ALERT_DISCORD_WEBHOOK). Used by the music worker
// (worker/main.ts) and, with its own label, by the events worker
// (events/worker/main.ts). A module of its own so the events worker bundle
// does not pull in the music worker.

import type { WorkerEnv } from '../server/env'

export async function makeAlert(env: Pick<WorkerEnv, 'KUMA_PUSH_URL' | 'ALERT_DISCORD_WEBHOOK'>, label = 'EFM Music Portal') {
  return async (title: string, detail: Record<string, unknown>) => {
    console.error(`[alert] ${title}`, JSON.stringify(detail).slice(0, 2000))
    const tasks: Promise<unknown>[] = []
    if (env.KUMA_PUSH_URL) {
      const u = new URL(env.KUMA_PUSH_URL)
      u.searchParams.set('status', 'down')
      u.searchParams.set('msg', title.slice(0, 200))
      tasks.push(fetch(u, { redirect: 'error', signal: AbortSignal.timeout(10_000) }))
    }
    if (env.ALERT_DISCORD_WEBHOOK) {
      tasks.push(
        fetch(env.ALERT_DISCORD_WEBHOOK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `⚠️ ${label}: ${title}`.slice(0, 1900), allowed_mentions: { parse: [] } }),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        }),
      )
    }
    await Promise.allSettled(tasks)
  }
}
