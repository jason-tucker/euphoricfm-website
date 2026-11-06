import { vi } from 'vitest'

export type Reply = { status: number; body?: unknown; html?: boolean }

// Minimal fetch stub: `routes` maps "METHOD /path-prefix" to a reply.
export function stubFetch(routes: Record<string, Reply | ((body: unknown) => Reply)>) {
  const calls: { method: string; url: string; body: unknown }[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    // JSON bodies are parsed; a FormData body is recorded as [field, kind] pairs.
    const body =
      typeof init?.body === 'string'
        ? JSON.parse(init.body)
        : init?.body instanceof FormData
          ? [...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? 'string' : 'file'])
          : undefined
    calls.push({ method, url, body })
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ')
      return m === method && url.startsWith(p!)
    })
    const r = key ? routes[key]! : { status: 200, body: { results: [] } }
    const reply = typeof r === 'function' ? r(body) : r
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? (reply.html ? 'text/html' : 'application/json') : null) },
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    }
  })
  vi.stubGlobal('fetch', fn)
  return calls
}
