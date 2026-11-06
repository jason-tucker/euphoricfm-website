// File primitives for the probe. Inputs live in /staging/uploads, which the
// web container can write, so every open is O_NOFOLLOW|O_NONBLOCK + fstat
// isFile, bytes are copied ONCE into a probe-private work dir while hashing,
// and every later step reads only that copy (no TOCTOU on the shared dir).
// Outputs are published with an exclusive tmp file + rename.

import { createHash, randomBytes } from 'node:crypto'
import { constants as FS } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export class ProbeReject extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ProbeReject'
  }
}

export async function copyNoFollowHashed(src: string, dst: string, maxBytes: number, expectedSize?: number): Promise<{ sha256: string; size: number }> {
  let fh
  try {
    fh = await open(src, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
  } catch {
    throw new ProbeReject('input_missing')
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new ProbeReject('input_not_regular')
    if (st.size < 1 || st.size > maxBytes) throw new ProbeReject('input_size')
    if (expectedSize !== undefined && st.size !== expectedSize) throw new ProbeReject('input_size_mismatch')
    const out = await open(dst, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600)
    const hash = createHash('sha256')
    let total = 0
    try {
      const buf = Buffer.alloc(1024 * 1024)
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > maxBytes) throw new ProbeReject('input_size')
        hash.update(buf.subarray(0, bytesRead))
        await out.write(buf.subarray(0, bytesRead))
      }
      await out.sync()
    } finally {
      await out.close()
    }
    if (expectedSize !== undefined && total !== expectedSize) throw new ProbeReject('input_size_mismatch')
    return { sha256: hash.digest('hex'), size: total }
  } finally {
    await fh.close()
  }
}

// Streams (1 MiB at a time, never through a symlink): a converted WAV's MP3
// is up to 35 MiB, and the probe's whole container has 256 MB.
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const fh = await open(path, FS.O_RDONLY | FS.O_NOFOLLOW)
  try {
    const buf = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      hash.update(buf.subarray(0, bytesRead))
    }
  } finally {
    await fh.close()
  }
  return hash.digest('hex')
}

export function reader(path: string) {
  return async (offset: number, len: number): Promise<Buffer> => {
    const fh = await open(path, FS.O_RDONLY | FS.O_NOFOLLOW)
    try {
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, offset)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }
}

// Copies in 1 MiB steps (see sha256File) into an exclusive tmp file, then
// renames it over destName (rename replaces a symlink itself, never its
// target).
export async function publishFile(srcInWork: string, destDir: string, destName: string): Promise<void> {
  const tmp = join(destDir, `.tmp-${randomBytes(12).toString('hex')}`)
  const src = await open(srcInWork, FS.O_RDONLY | FS.O_NOFOLLOW)
  try {
    const fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644)
    try {
      const buf = Buffer.alloc(1024 * 1024)
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null)
        if (bytesRead === 0) break
        await fh.write(buf.subarray(0, bytesRead))
      }
      await fh.sync()
    } finally {
      await fh.close()
    }
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  } finally {
    await src.close()
  }
  try {
    await rename(tmp, join(destDir, destName))
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}
