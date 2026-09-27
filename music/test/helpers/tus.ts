import { Jar, req } from './http'

const TUS = { 'tus-resumable': '1.0.0' }

export async function tusCreate(jar: Jar, length: number, extra: Record<string, string> = {}) {
  return req(jar, '/api/uploads', { method: 'POST', headers: { ...TUS, 'upload-length': String(length), ...extra } })
}

export async function tusPatch(jar: Jar, location: string, offset: number, chunk: Buffer, extra: Record<string, string> = {}) {
  return req(jar, location, {
    method: 'PATCH',
    body: new Uint8Array(chunk),
    headers: { ...TUS, 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream', ...extra },
  })
}

export async function tusHead(jar: Jar, location: string, extra: Record<string, string> = {}) {
  return req(jar, location, { method: 'HEAD', headers: { ...TUS, ...extra } })
}

// Uploads a whole buffer in ≤8 MB chunks; returns the upload id.
export async function tusUpload(jar: Jar, data: Buffer, chunk = 8 * 1024 * 1024): Promise<string> {
  const c = await tusCreate(jar, data.length)
  if (c.status !== 201) throw new Error(`tus create ${c.status} ${await c.text()}`)
  const loc = c.headers.get('location')!
  let off = 0
  while (off < data.length) {
    const part = data.subarray(off, Math.min(off + chunk, data.length))
    const p = await tusPatch(jar, loc, off, part)
    if (p.status !== 204) throw new Error(`tus patch ${p.status} ${await p.text()}`)
    off += part.length
  }
  return loc.split('/').pop()!
}
