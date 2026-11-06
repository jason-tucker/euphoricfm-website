// Typed HTTP errors thrown by authz/validation helpers and turned into JSON
// responses by withRoute(). Bodies carry a short machine code only.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(code)
    this.name = 'HttpError'
  }
}

export const unauthorized = () => new HttpError(401, 'unauthorized')
export const forbidden = (code = 'forbidden') => new HttpError(403, code)
// Not-owned resources answer 404 (not 403) so ids cannot be probed.
export const notFound = () => new HttpError(404, 'not_found')
export const conflict = (code = 'conflict') => new HttpError(409, code)
export const badRequest = (code = 'bad_request', extra?: Record<string, unknown>) => new HttpError(400, code, extra)
// Connection: close: the rest of an oversized body must not poison a pooled
// keep-alive socket.
export const tooLarge = () => new HttpError(413, 'payload_too_large', undefined, { Connection: 'close' })
export const unavailable = (code = 'unavailable', retryAfterS?: number) =>
  new HttpError(503, code, undefined, retryAfterS ? { 'Retry-After': String(retryAfterS) } : undefined)
