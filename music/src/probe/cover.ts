// Cover handling (plan §3.4 step 5): whatever the tag carried, the portal
// only ever serves a JPEG the probe re-encoded, ≤1000 px on the long side.
// Input type is decided by magic bytes (never the tag's MIME string) and the
// matching demuxer is FORCED; raster dimensions are read from the header and
// bounded before any decoder runs. SVG is rasterised by rsvg-convert in an
// empty private directory (no network in this container), then re-encoded.

import { runLimited } from './exec'

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'svg'

export const MAX_EDGE = 8000
export const MAX_PIXELS = 40_000_000
export const OUT_EDGE = 1000

export function sniffImage(b: Buffer): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif'
  const head = b.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg'
  return null
}

export function imageDims(b: Buffer, kind: ImageKind): { w: number; h: number } | null {
  try {
    if (kind === 'png') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
    if (kind === 'gif') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
    if (kind === 'webp') {
      const chunk = b.toString('latin1', 12, 16)
      if (chunk === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21)
        return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) }
      }
      if (chunk === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
      return null
    }
    if (kind === 'jpeg') {
      let o = 2
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) return null
        const marker = b[o + 1]!
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          o += 2
          continue
        }
        const len = b.readUInt16BE(o + 2)
        // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5) }
        }
        o += 2 + len
      }
      return null
    }
  } catch {
    return null
  }
  return null
}

export function dimsAcceptable(d: { w: number; h: number } | null): boolean {
  return !!d && d.w > 0 && d.h > 0 && d.w <= MAX_EDGE && d.h <= MAX_EDGE && d.w * d.h <= MAX_PIXELS
}

const DEMUXER: Record<Exclude<ImageKind, 'svg'>, string> = { jpeg: 'jpeg_pipe', png: 'png_pipe', webp: 'webp_pipe', gif: 'gif' }

async function ffmpegToJpeg(input: string, kind: Exclude<ImageKind, 'svg'>, output: string): Promise<boolean> {
  const r = await runLimited(
    'ffmpeg',
    [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-protocol_whitelist', 'file',
      '-threads', '1',
      '-filter_threads', '1',
      '-f', DEMUXER[kind], '-i', `file:${input}`,
      '-frames:v', '1',
      '-vf', `scale=w='min(${OUT_EDGE},iw)':h='min(${OUT_EDGE},ih)':force_original_aspect_ratio=decrease:threads=1,format=yuvj420p`,
      '-c:v', 'mjpeg', '-q:v', '3', '-threads', '1',
      '-map_metadata', '-1',
      '-f', 'image2', '-update', '1',
      `file:${output}`,
    ],
    { timeoutS: 20, vmemKb: 786432 },
  )
  return r.code === 0
}

// Returns the output JPEG path's dims, or null when the cover is dropped.
export async function reencodeCover(input: string, head: Buffer, workDir: string, output: string): Promise<{ w: number; h: number } | null> {
  const kind = sniffImage(head)
  if (!kind) return null
  if (kind === 'svg') {
    const png = `${workDir}/cover-svg.png`
    const r = await runLimited(
      'rsvg-convert',
      ['--format=png', `--width=${OUT_EDGE}`, `--height=${OUT_EDGE}`, '--keep-aspect-ratio', '--output', png, input],
      { timeoutS: 20, vmemKb: 786432, cwd: workDir },
    )
    if (r.code !== 0) return null
    if (!(await ffmpegToJpeg(png, 'png', output))) return null
  } else {
    if (!dimsAcceptable(imageDims(head, kind))) return null
    if (!(await ffmpegToJpeg(input, kind, output))) return null
  }
  return { w: 0, h: 0 } // real dims are read back by the caller from the JPEG
}
