// 'finalize' requests (from in-worker only), plan §3.4:
//   1. verify approved_sha256 on a private copy of the staged upload;
//   2. ffmpeg -map_metadata -1 -c copy (no ID3 written by ffmpeg);
//   3. write a clean ID3 (title, artist, album, genre, APIC = the probe's
//      re-encoded JPEG, itself sha-verified);
//   4. publish /staging/final/<id>.mp3 and report final_sha256.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import NodeID3 from 'node-id3'
import { MAX_UPLOAD_BYTES, type FinalizeRequest, type SpoolResult } from '../server/spool/protocol'
import { runLimited } from './exec'
import { copyNoFollowHashed, ProbeReject, publishFile, reader, sha256File } from './files'
import { checkMp3Magic } from './magic'

export type FinalizeDirs = { uploads: string; work: string; final: string }

export function stripArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-protocol_whitelist', 'file',
    '-threads', '1',
    '-f', 'mp3', '-i', `file:${input}`,
    '-map', '0:a:0',
    '-map_metadata', '-1',
    '-c', 'copy',
    '-threads', '1',
    '-id3v2_version', '0',
    '-write_id3v1', '0',
    '-fflags', '+bitexact',
    '-flags:a', '+bitexact',
    '-f', 'mp3',
    `file:${output}`,
  ]
}

export async function runFinalize(req: FinalizeRequest, dirs: FinalizeDirs): Promise<SpoolResult> {
  const base = { v: 1 as const, id: req.id, type: 'finalize' as const, source: 'in-worker' as const }
  const work = await mkdtemp(join(dirs.work, `f-${req.id}-`))
  try {
    const copy = join(work, 'in.mp3')
    const { sha256 } = await copyNoFollowHashed(join(dirs.uploads, req.upload), copy, MAX_UPLOAD_BYTES)
    if (sha256 !== req.approvedSha256) throw new ProbeReject('sha_mismatch')
    const size = (await stat(copy)).size
    const m = await checkMp3Magic(reader(copy), size)
    if (!m.ok) throw new ProbeReject(m.reason)

    let imageBuffer: Buffer | null = null
    if (req.cover) {
      const coverCopy = join(work, 'cover.jpg')
      const c = await copyNoFollowHashed(join(dirs.uploads, req.cover.file), coverCopy, 2 * 1024 * 1024)
      if (c.sha256 !== req.cover.sha256) throw new ProbeReject('cover_sha_mismatch')
      imageBuffer = await readFile(coverCopy)
      if (!(imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff)) throw new ProbeReject('cover_not_jpeg')
    }

    const stripped = join(work, 'stripped.mp3')
    const r = await runLimited('ffmpeg', stripArgs(copy, stripped), { timeoutS: 60, vmemKb: 786432, cwd: work })
    if (r.code !== 0) throw new ProbeReject(r.timedOut ? 'strip_timeout' : 'strip_failed')

    const tags: NodeID3.Tags = { title: req.tags.title, artist: req.tags.artist, album: req.tags.album, genre: req.tags.genre }
    if (imageBuffer) tags.image = { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer }
    const w = NodeID3.write(tags, stripped)
    if (w !== true) throw new ProbeReject('id3_write_failed')

    const outSize = (await stat(stripped)).size
    const m2 = await checkMp3Magic(reader(stripped), outSize)
    if (!m2.ok) throw new ProbeReject('final_not_mp3')
    const finalSha256 = await sha256File(stripped)
    const file = `${req.id}.mp3`
    await publishFile(stripped, dirs.final, file)
    // Re-hash what landed, so the reported sha is of the published bytes.
    if ((await sha256File(join(dirs.final, file))) !== finalSha256) throw new ProbeReject('publish_mismatch')
    return { ...base, ok: true, file, finalSha256, size: outSize }
  } catch (e) {
    if (e instanceof ProbeReject) return { ...base, ok: false, error: e.code }
    return { ...base, ok: false, error: 'finalize_failed' }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
