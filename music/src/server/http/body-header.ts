import { DEFAULT_BODY_LIMIT } from './limits'

// Cheap header-only pre-check for middleware; handlers still stream-count.
export function readBodyLimitHeaderOnly(headers: Headers, limit = DEFAULT_BODY_LIMIT): 'ok' | 'too_large' {
  const cl = headers.get('content-length')
  if (cl !== null && /^\d{1,15}$/.test(cl) && Number(cl) > limit) return 'too_large'
  return 'ok'
}
