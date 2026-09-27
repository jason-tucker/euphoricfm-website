// Client-side fetch helper. Every mutation is a same-origin POST/PATCH/PUT
// through fetch (the browser adds Origin and Sec-Fetch-Site, which the CSRF
// gate requires). Errors become ApiError with a readable message.

import { CONFLICT_TEXT, errorText } from './messages'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues: string[] = [],
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const method = init.method ?? (init.json === undefined && init.form === undefined ? 'GET' : 'POST')
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      // A FormData body sets its own multipart content-type (with boundary).
      headers: init.json === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
    })
  } catch {
    throw new ApiError(0, 'network')
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
  const body = isJson ? await res.json().catch(() => null) : null
  if (!res.ok) {
    const b = body as { error?: unknown; issues?: unknown } | null
    // A 404/405 with a non-JSON body is Next's own page: the route is missing.
    const code = typeof b?.error === 'string' ? b.error : res.status === 404 || res.status === 405 ? 'endpoint_missing' : `http_${res.status}`
    const issues = Array.isArray(b?.issues) ? b.issues.filter((i): i is string => typeof i === 'string') : []
    throw new ApiError(res.status, code, issues, b && typeof b === 'object' ? (b as Record<string, unknown>) : null)
  }
  return body as T
}

export type ConflictContext = keyof typeof CONFLICT_TEXT

// The one place an error becomes the sentence shown to the user.
export function messageFor(err: unknown, conflict?: ConflictContext): string {
  if (err instanceof ApiError) {
    if (err.status === 409 && conflict && (err.code === 'state_changed' || err.code === 'conflict')) return CONFLICT_TEXT[conflict]
    if (err.code === 'daily_cap' && typeof err.body?.limit === 'number') {
      return `You've reached today's limit of ${err.body.limit} requests of this kind. Try again tomorrow.`
    }
    const base = errorText(err.code, err.status)
    return err.issues.length ? `${base} (${err.issues.join('; ')})` : base
  }
  return errorText('internal')
}
