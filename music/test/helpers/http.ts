import { request as httpRequest } from 'node:http'
// Tiny fetch wrapper with a cookie jar (the portal's cookies are __Host-
// Secure; undici does not enforce cookie rules, the jar just replays them).

export const ORIGIN = 'https://music.euphoric.fm'
export const WEB = () => process.env.E2E_WEB_URL!

export class Jar {
  cookies = new Map<string, string>()
  store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';')
      const i = pair!.indexOf('=')
      const name = pair!.slice(0, i).trim()
      const value = pair!.slice(i + 1).trim()
      const expired = attrs.some((a) => /max-age=0\b/i.test(a) || /expires=thu, 01 jan 1970/i.test(a))
      if (expired || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  get(name: string) {
    return this.cookies.get(name)
  }
}

// A random /64 in the IPv6 documentation range per call, so repeated test
// runs (and the rate limiter's per-/64 buckets) never share a bucket.
export function freshIp(): string {
  const h = () => Math.floor(Math.random() * 0x10000).toString(16)
  return `2001:db8:${h()}:${h()}::${h()}`
}

export type ReqOpts = {
  method?: string
  body?: BodyInit | null
  json?: unknown
  headers?: Record<string, string>
  sameOrigin?: boolean // add Origin + Sec-Fetch-Site: same-origin (default for unsafe methods)
  ip?: string
}

export async function req(jar: Jar | null, path: string, o: ReqOpts = {}): Promise<Response> {
  const method = (o.method ?? (o.json !== undefined || o.body ? 'POST' : 'GET')).toUpperCase()
  const headers: Record<string, string> = { 'cf-connecting-ip': o.ip ?? freshIp(), ...(o.headers ?? {}) }
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  if (o.sameOrigin ?? unsafe) {
    headers.origin ??= ORIGIN
    headers['sec-fetch-site'] ??= 'same-origin'
  }
  if (jar && jar.cookies.size) headers.cookie = jar.header()
  let body = o.body ?? undefined
  if (o.json !== undefined) {
    body = JSON.stringify(o.json)
    headers['content-type'] ??= 'application/json'
  }
  const url = path.startsWith('http') ? path : `${WEB()}${path}`
  const res = await fetch(url, { method, headers, body, redirect: 'manual', ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit)
  jar?.store(res)
  return res
}

export async function control(path: string, body?: unknown) {
  const r = await fetch(`${process.env.MOCKS_CONTROL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`mock control ${path}: ${r.status}`)
  return r.json()
}

// One request on its OWN connection (no agent, Connection: close), for
// oversized bodies whose early 413/411 may close the socket: nothing can leak
// into the next request's pooled keep-alive connection. Body chunks stop as
// soon as the response arrives. If the socket dies before any response (the
// server closed while we were still sending: EPIPE/ECONNRESET), the request
// is retried on a fresh connection, at most twice.
export function reqFresh(
  jar: Jar | null,
  path: string,
  o: { method?: string; headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[] } = {},
): Promise<{ status: number; text: string }> {
  const attempt = () =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const url = new URL(path.startsWith('http') ? path : `${WEB()}${path}`)
      const headers: Record<string, string> = { 'cf-connecting-ip': freshIp(), origin: ORIGIN, 'sec-fetch-site': 'same-origin', connection: 'close', ...(o.headers ?? {}) }
      if (jar && jar.cookies.size) headers.cookie = jar.header()
      const body = o.body === undefined ? undefined : Buffer.from(o.body)
      if (body) headers['content-length'] = String(body.length)
      let settled = false
      let responded = false
      const r = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: o.method ?? 'POST', headers, agent: false }, (res) => {
        responded = true
        // The status line is what callers assert; a reset after it still counts.
        const parts: Buffer[] = []
        const done = () => {
          if (settled) return
          settled = true
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') })
        }
        res.on('data', (c: Buffer) => parts.push(c))
        res.on('end', done)
        res.on('error', done)
        res.on('close', done)
      })
      r.on('error', (e) => {
        if (settled || responded) return
        settled = true
        reject(e)
      })
      const pieces: Buffer[] = o.chunks ?? (body ? Array.from({ length: Math.ceil(body.length / 65536) }, (_, i) => body.subarray(i * 65536, (i + 1) * 65536)) : [])
      if (pieces.length === 0) {
        r.flushHeaders()
        if (body || !o.chunks) r.end()
        return // chunked with no data: headers only, wait for the response
      }
      const write = (i: number) => {
        if (responded || r.destroyed) return
        if (i >= pieces.length) return void r.end()
        r.write(pieces[i], () => write(i + 1))
      }
      write(0)
    })
  return (async () => {
    for (let n = 0; ; n++) {
      try {
        return await attempt()
      } catch (e) {
        if (n >= 2) throw e
      }
    }
  })()
}
