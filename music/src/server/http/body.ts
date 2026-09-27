// Streaming body cap. Content-Length is checked first, then the stream is
// counted, so a chunked or lying request cannot exceed the cap either.

import { HttpError, tooLarge } from './errors'

import { DEFAULT_BODY_LIMIT } from './limits'
export { DEFAULT_BODY_LIMIT }

// Once the cap is exceeded the rest of the body is READ AND DISCARDED (up to
// DRAIN_FACTOR x the limit) rather than cancelled: cancelling raced Next's
// request-stream plumbing (an unhandled AbortError and a reset keep-alive
// socket). A stream that errors or ends early is never parsed as a complete
// body: an error is 413 if the cap was already exceeded, else 400 bad_body.
// The 413 carries `Connection: close` so the peer does not reuse the socket.
const DRAIN_FACTOR = 8

export async function readBodyLimited(req: Request, limit = DEFAULT_BODY_LIMIT): Promise<Buffer> {
  const cl = req.headers.get('content-length')
  if (cl !== null) {
    if (!/^\d{1,12}$/.test(cl)) throw new HttpError(400, 'bad_content_length')
    if (Number(cl) > limit) throw tooLarge()
  }
  if (!req.body) return Buffer.alloc(0)
  const reader = req.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let over = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (!over && total > limit) {
        over = true
        chunks.length = 0
      }
      if (!over) chunks.push(Buffer.from(value))
      else if (total > limit * DRAIN_FACTOR) {
        // Stop reading an abusive stream; the 413 closes the connection.
        reader.releaseLock()
        break
      }
    }
  } catch {
    throw over ? tooLarge() : new HttpError(400, 'bad_body')
  }
  if (over) throw tooLarge()
  if (cl !== null && total !== Number(cl)) throw new HttpError(400, 'bad_body')
  return Buffer.concat(chunks, total)
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
