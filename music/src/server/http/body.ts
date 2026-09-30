// Streaming body cap. Content-Length is checked first, then the stream is
// counted, so a chunked or lying request cannot exceed the cap either.

import { HttpError, tooLarge } from './errors'

import { DEFAULT_BODY_LIMIT } from './limits'
export { DEFAULT_BODY_LIMIT }

// Once the cap is exceeded the rest of the body is READ AND DISCARDED (up to
// DRAIN_FACTOR x the limit) rather than cancelled: cancelling raced Next's
// request-stream plumbing (an unhandled AbortError and a reset keep-alive
// socket). Bytes are COUNTED before anything else, so once the cap has been
// exceeded the answer is 413 whatever the stream does next (error, early
// end). A stream that errors or ends early below the cap is never parsed as a
// complete body: 400 bad_body. The 413 carries `Connection: close` so the
// peer does not reuse the socket.
const DRAIN_FACTOR = 8

type Consumed = { total: number; over: boolean; failed: boolean }

async function consumeBody(body: ReadableStream<Uint8Array>, limit: number, keep: Buffer[] | null): Promise<Consumed> {
  const reader = body.getReader()
  let total = 0
  let over = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (!over && total > limit) {
        over = true
        if (keep) keep.length = 0
      }
      if (!over) keep?.push(Buffer.from(value))
      else if (total > limit * DRAIN_FACTOR) {
        // Stop reading an abusive stream; the 413 closes the connection.
        reader.releaseLock()
        break
      }
    }
  } catch {
    return { total, over, failed: true }
  }
  return { total, over, failed: false }
}

function declaredLength(req: Request, limit: number): number | null {
  const cl = req.headers.get('content-length')
  if (cl === null) return null
  if (!/^\d{1,12}$/.test(cl)) throw new HttpError(400, 'bad_content_length')
  if (Number(cl) > limit) throw tooLarge()
  return Number(cl)
}

export async function readBodyLimited(req: Request, limit = DEFAULT_BODY_LIMIT): Promise<Buffer> {
  const cl = declaredLength(req, limit)
  if (!req.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  const c = await consumeBody(req.body, limit, chunks)
  if (c.over) throw tooLarge()
  if (c.failed) throw new HttpError(400, 'bad_body')
  if (cl !== null && c.total !== cl) throw new HttpError(400, 'bad_body')
  return Buffer.concat(chunks, c.total)
}

// For src/middleware.ts: reads the middleware's copy of the body to its END,
// counting and discarding, and says whether it fits the cap. Same rules as
// readBodyLimited, but nothing is kept. See the middleware for why the body
// must have ended before a route handler runs.
// `keep`: the bytes are also collected there (the middleware reads the body
// of a draft autosave edit to pick its rate-limit bucket).
export async function checkBodyLimited(req: Request, limit = DEFAULT_BODY_LIMIT, keep: Buffer[] | null = null): Promise<'ok' | 'too_large' | 'bad_body'> {
  let cl: number | null
  try {
    cl = declaredLength(req, limit)
  } catch (e) {
    return e instanceof HttpError && e.status === 413 ? 'too_large' : 'bad_body'
  }
  if (!req.body) return 'ok'
  const c = await consumeBody(req.body, limit, keep)
  if (c.over) return 'too_large'
  if (c.failed || (cl !== null && c.total !== cl)) return 'bad_body'
  return 'ok'
}

export async function readJsonLimited(req: Request, limit = DEFAULT_BODY_LIMIT): Promise<unknown> {
  const ct = req.headers.get('content-type') ?? ''
  if (!/^application\/json(\s*;|$)/i.test(ct)) throw new HttpError(415, 'unsupported_media_type')
  const raw = await readBodyLimited(req, limit)
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

// A body of a DECLARED size read into ONE preallocated buffer: no chunk
// list and no Buffer.concat, so peak memory is Content-Length plus the chunk
// in flight (review SEC-1). Content-Length is required (411) and capped (413)
// before a byte is read; a body that ends short, runs past it or errors is
// 400 bad_body. With `deadlineMs`, a body still incomplete after that long is
// 408 body_timeout, which bounds how long a slow sender can hold whatever the
// caller took before reading (the art upload's in-flight slot); a client
// disconnect (req.signal) ends the read at once.
export async function readBodyExact(req: Request, limit: number, deadlineMs?: number): Promise<Buffer> {
  const cl = req.headers.get('content-length')
  if (cl === null) throw new HttpError(411, 'content_length_required', undefined, { Connection: 'close' })
  if (!/^\d{1,12}$/.test(cl)) throw new HttpError(400, 'bad_content_length')
  const n = Number(cl)
  if (n > limit) throw tooLarge()
  const out = Buffer.alloc(n)
  if (!req.body) {
    if (n === 0) return out
    throw new HttpError(400, 'bad_body')
  }
  const reader = req.body.getReader()
  // Stop waiting at the deadline, or when the client goes away (Next aborts
  // req.signal on disconnect; the body stream alone may just stall).
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stop = new Promise<'expired' | 'aborted'>((resolve) => {
    if (deadlineMs !== undefined) timer = setTimeout(() => resolve('expired'), deadlineMs)
    const signal = (req as { signal?: AbortSignal }).signal
    if (signal) {
      if (signal.aborted) resolve('aborted')
      onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  let total = 0
  try {
    for (;;) {
      const next = reader.read()
      const r = await Promise.race([next, stop])
      if (r === 'expired' || r === 'aborted') {
        next.catch(() => {}) // releaseLock() rejects the pending read
        release(reader)
        throw r === 'expired' ? new HttpError(408, 'body_timeout', undefined, { Connection: 'close' }) : new HttpError(400, 'bad_body', undefined, { Connection: 'close' })
      }
      if (r.done) break
      if (total + r.value.byteLength > n) {
        // HTTP/1.1 frames the body by Content-Length, so this is defensive.
        release(reader)
        throw new HttpError(400, 'bad_body', undefined, { Connection: 'close' })
      }
      out.set(r.value, total)
      total += r.value.byteLength
    }
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, 'bad_body')
  } finally {
    clearTimeout(timer)
    if (onAbort) (req as { signal?: AbortSignal }).signal?.removeEventListener('abort', onAbort)
  }
  if (total !== n) throw new HttpError(400, 'bad_body')
  return out
}

function release(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock()
  } catch {
    // an older streams implementation throws while a read is pending
  }
}
