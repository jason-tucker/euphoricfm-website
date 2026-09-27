// Streaming body cap. Content-Length is checked first, then the stream is
// counted, so a chunked or lying request cannot exceed the cap either.

import { HttpError, tooLarge } from './errors'

import { DEFAULT_BODY_LIMIT } from './limits'
export { DEFAULT_BODY_LIMIT }

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
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(Buffer.from(value))
  }
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
