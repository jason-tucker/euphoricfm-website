// 'art' requests (from in-web only): a standalone album-art upload (art
// contract 2026-09-27). Same hardened decode as embedded covers:
//   1. a private, read-only copy of the raw bytes (no-follow, size-checked);
//   2. type by magic bytes: JPEG, PNG or WebP only (never SVG or GIF here);
//   3. header validated and dimensions bounded BEFORE any decoder runs
//      (PNG IHDR first, JPEG single SOF, WebP VP8/VP8L headers; 12 MP);
//   4. ffmpeg re-encode to a baseline JPEG ≤1000 px, all metadata stripped,
//      under -max_pixels, ulimit -v and a timeout, in its own process group;
//   5. published to <art>/<artId>/cover.jpg (never overwritten), sha256 of
//      the published bytes reported.
// 'art_release' deletes an expired JPEG: the probe is the only writer of the
// art directory.

import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ART_JPEG_FILE, MAX_ART_BYTES, type ArtReleaseRequest, type ArtRequest, type SpoolResult } from '../server/spool/protocol'
import { dimsAcceptable, imageComplete, imageDims, reencodeCover, sniffImage } from './cover'
import { copyNoFollowHashed, ProbeReject, publishFile, sha256File } from './files'

export type ArtDirs = { artIn: string; art: string; work: string }

export const ART_KINDS = new Set(['jpeg', 'png', 'webp'])

export async function runArt(req: ArtRequest, dirs: ArtDirs): Promise<SpoolResult> {
  const base = { v: 1 as const, id: req.id, type: 'art' as const, source: 'in-web' as const }
  const work = await mkdtemp(join(dirs.work, `a-${req.id}-`))
  try {
    const raw = join(work, 'raw')
    await copyNoFollowHashed(join(dirs.artIn, req.id), raw, MAX_ART_BYTES, req.expectedSize)
    await chmod(raw, 0o400)
    const bytes = await readFile(raw)
    const kind = sniffImage(bytes)
    if (!kind || !ART_KINDS.has(kind)) throw new ProbeReject('unsupported_image_type')
    const dims = imageDims(bytes, kind)
    if (!dims) throw new ProbeReject('unreadable_image_header')
    if (!dimsAcceptable(dims)) throw new ProbeReject('image_too_large')
    if (!imageComplete(bytes, kind)) throw new ProbeReject('image_truncated')
    const out = join(work, ART_JPEG_FILE)
    if (!(await reencodeCover(raw, bytes, work, out))) throw new ProbeReject('image_decode_failed')
    const jpg = await readFile(out)
    const d = imageDims(jpg, 'jpeg')
    if (!d || d.w < 1 || d.h < 1 || d.w > 1000 || d.h > 1000 || sniffImage(jpg) !== 'jpeg') throw new ProbeReject('reencode_invalid')
    const dir = join(dirs.art, req.id)
    try {
      await mkdir(dir, { mode: 0o750 }) // not recursive: an existing dir means this id was already used
    } catch {
      throw new ProbeReject('art_exists')
    }
    await publishFile(out, dir, ART_JPEG_FILE)
    const sha256 = await sha256File(join(dir, ART_JPEG_FILE))
    if (sha256 !== (await sha256File(out))) throw new ProbeReject('publish_mismatch')
    return { ...base, ok: true, file: ART_JPEG_FILE, sha256, size: jpg.length, width: d.w, height: d.h }
  } catch (e) {
    if (e instanceof ProbeReject) return { ...base, ok: false, error: e.code }
    return { ...base, ok: false, error: 'art_failed' }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export async function runArtRelease(req: ArtReleaseRequest, dirs: ArtDirs): Promise<SpoolResult> {
  const base = { v: 1 as const, id: req.id, type: 'art_release' as const, source: 'in-web' as const }
  const dir = join(dirs.art, req.artId)
  // unlink never follows a symlink; rmdir only removes an empty directory.
  await unlink(join(dir, ART_JPEG_FILE)).catch(() => {})
  await rmdir(dir).catch(() => {})
  return { ...base, ok: true, artId: req.artId }
}
