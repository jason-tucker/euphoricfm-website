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
