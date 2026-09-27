// A strict multipart/form-data reader for exactly ONE file part (the art
// upload's `art` field), working on the single body buffer the route read
// (v0.2.1, review SEC-1). The previous path (undici Response.formData() +
// File.arrayBuffer()) held about four copies of a 5 MB body per request; this
// one returns a view (subarray) into the body buffer, so the image bytes are
// never copied. Anything beyond the one shape browsers send is refused:
//
//   --<boundary>\r\n
//   Content-Disposition: form-data; name="art"; filename="…"\r\n
//   [other part headers]\r\n
//   \r\n
//   <file bytes>\r\n
//   --<boundary>--[\r\n epilogue, ignored]
//
// No preamble, no second part, no header block over 8 KB, no duplicate
// Content-Disposition or name / filename parameters. The part's own
// Content-Type is ignored: the type is decided by magic bytes afterwards.

import { HttpError } from '../http/errors'

const MAX_PART_HEADER_BYTES = 8 * 1024
// RFC 2046 bchars: 1-70 characters, the last one not a space.
const BOUNDARY_RE = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/

const bad = () => new HttpError(400, 'bad_multipart')

// boundary parameter of a multipart/form-data Content-Type (quoted or not).
export function multipartBoundary(contentType: string): string | null {
  if (!/^multipart\/form-data\s*;/i.test(contentType)) return null
  const m = /;\s*boundary=(?:"([^"]*)"|([^\s;"]*))/i.exec(contentType)
  const b = m ? (m[1] ?? m[2] ?? '') : ''
  return BOUNDARY_RE.test(b) ? b : null
}

type Disposition = { name: string | null; filename: string | null }

// Content-Disposition: form-data; name="…"; filename="…" (filename* counts
// as a filename too). Quoted values may contain ';'. Browsers percent-encode
// '"', CR and LF inside them (HTML form encoding) and never backslash-escape,
// so a quoted value is taken verbatim up to the next '"'. Duplicates are
// refused.
export function parseDisposition(value: string): Disposition | null {
  const v = value.trim()
  const m = /^form-data\s*(;|$)/i.exec(v)
  if (!m) return null
  const out: Disposition = { name: null, filename: null }
  const seen = new Set<string>()
  let rest = v.slice(m[0].length)
  const param = /^\s*([A-Za-z0-9!#$&+\-.^_`|~*]+)\s*=\s*("[^"\r\n]*"|[^;\s"]*)\s*(;|$)/
  while (rest.trim() !== '') {
    const p = param.exec(rest)
    if (!p) return null
    const key = p[1]!.toLowerCase()
    if (seen.has(key)) return null
    seen.add(key)
    const raw = p[2]!
    const val = raw.startsWith('"') ? raw.slice(1, -1) : raw
    if (key === 'name') out.name = val
    else if (key === 'filename' || key === 'filename*') {
      if (out.filename !== null) return null
      out.filename = val
    }
    rest = rest.slice(p[0].length)
  }
  return out
}

// Returns the single part's body as a view into `body` (no copy), plus
// whether it was a file part (had a filename) and its field name.
export function singlePart(body: Buffer, boundary: string): { name: string | null; isFile: boolean; data: Buffer } {
  const open = Buffer.from(`--${boundary}`, 'latin1')
  const delim = Buffer.from(`\r\n--${boundary}`, 'latin1')
  if (!body.subarray(0, open.length).equals(open)) throw bad()
  let pos = open.length
  // "--<boundary>--" straight away: a form with no fields at all.
  if (body[pos] === 0x2d && body[pos + 1] === 0x2d) throw new HttpError(400, 'exactly_one_art_field')
  if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) throw bad()
  pos += 2
  const headEnd = body.indexOf('\r\n\r\n', pos, 'latin1')
  if (headEnd < 0 || headEnd - pos > MAX_PART_HEADER_BYTES) throw bad()
  let disposition: Disposition | null = null
  for (const line of body.toString('utf8', pos, headEnd).split('\r\n')) {
    const i = line.indexOf(':')
    if (i < 1) throw bad()
    if (line.slice(0, i).trim().toLowerCase() !== 'content-disposition') continue
    if (disposition) throw bad()
    disposition = parseDisposition(line.slice(i + 1))
    if (!disposition) throw bad()
  }
  if (!disposition) throw bad()
  const dataStart = headEnd + 4
  const end = body.indexOf(delim, dataStart)
  if (end < 0) throw bad()
  const after = end + delim.length
  if (body[after] === 0x0d && body[after + 1] === 0x0a) throw new HttpError(400, 'exactly_one_art_field') // a second part follows
  if (body[after] !== 0x2d || body[after + 1] !== 0x2d) throw bad()
  return { name: disposition.name, isFile: disposition.filename !== null, data: body.subarray(dataStart, end) }
}
