// Serves staged bytes that the probe accepted: audio as audio/mpeg, cover as
// the probe's re-encoded JPEG. nosniff + CSP sandbox + attachment, never a
// client-chosen type, never through a symlink.

import { constants as FS } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { MEDIA_CSP } from '../http/csp'
import { notFound } from '../http/errors'
import { MEDIA_URL_TTL_S } from './signing'

export const MEDIA_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': MEDIA_CSP,
  'Cache-Control': 'private, no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

// v0.4.1: a cover / art image may be kept by the browser for the lifetime
// of its signed URL (media/signing.ts MEDIA_URL_TTL_S): the URL is bound to
// the viewer and the expiry, so a re-render within it needs no re-download.
// Audio stays no-store.
export const IMAGE_CACHE_CONTROL = `private, max-age=${MEDIA_URL_TTL_S}`

export async function serveStagedFile(opts: {
  dir: string
  name: string // already regex-validated by the caller
  contentType: 'audio/mpeg' | 'image/jpeg'
  downloadName: string
  range: string | null
  magic?: (head: Buffer) => boolean
}): Promise<Response> {
  let fh
  try {
    fh = await open(join(opts.dir, opts.name), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
  } catch {
    throw notFound()
  }
  const st = await fh.stat()
  if (!st.isFile() || st.size === 0) {
    await fh.close()
    throw notFound()
  }
  if (opts.magic) {
    const head = Buffer.alloc(Math.min(16, st.size))
    await fh.read(head, 0, head.length, 0)
    if (!opts.magic(head)) {
      await fh.close()
      throw notFound()
    }
  }
  let start = 0
  let end = st.size - 1
  let status = 200
  const m = opts.range ? /^bytes=(\d{0,12})-(\d{0,12})$/.exec(opts.range) : null
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') {
      start = Math.max(0, st.size - Number(m[2]))
    } else {
      start = Number(m[1])
      if (m[2] !== '') end = Math.min(end, Number(m[2]))
    }
    if (start > end || start >= st.size) {
      await fh.close()
      return new Response(null, { status: 416, headers: { ...MEDIA_HEADERS, 'Content-Range': `bytes */${st.size}` } })
    }
    status = 206
  }
  const stream = fh.createReadStream({ start, end, autoClose: true })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (c) => controller.enqueue(typeof c === 'string' ? Buffer.from(c) : new Uint8Array(c)))
      stream.on('end', () => controller.close())
      stream.on('error', (e) => controller.error(e))
    },
    cancel() {
      stream.destroy()
    },
  })
  const headers: Record<string, string> = {
    ...MEDIA_HEADERS,
    ...(opts.contentType === 'image/jpeg' ? { 'Cache-Control': IMAGE_CACHE_CONTROL } : {}),
    'Content-Type': opts.contentType,
    'Content-Length': String(end - start + 1),
    'Content-Disposition': `attachment; filename="${opts.downloadName}"`,
    'Accept-Ranges': 'bytes',
  }
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
  return new Response(body, { status, headers })
}

export const isJpeg = (h: Buffer) => h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff
