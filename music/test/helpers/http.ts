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

let ipCounter = 1
export function freshIp(): string {
  ipCounter++
  return `198.51.100.${(ipCounter % 250) + 1}`
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
