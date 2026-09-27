// File primitives for the probe. Inputs live in /staging/uploads, which the
// web container can write, so every open is O_NOFOLLOW|O_NONBLOCK + fstat
// isFile, bytes are copied ONCE into a probe-private work dir while hashing,
// and every later step reads only that copy (no TOCTOU on the shared dir).
// Outputs are published with an exclusive tmp file + rename.

import { createHash, randomBytes } from 'node:crypto'
import { constants as FS } from 'node:fs'
import { open, rename, unlink, readFile } from 'node:fs/promises'
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

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
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

export async function publishFile(srcInWork: string, destDir: string, destName: string): Promise<void> {
  const tmp = join(destDir, `.tmp-${randomBytes(12).toString('hex')}`)
  const data = await readFile(srcInWork)
  const fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await rename(tmp, join(destDir, destName))
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}
