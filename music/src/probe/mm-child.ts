// music-metadata runs HERE, in a short-lived child process (heap-capped,
// killed at 20 s), never in the probe's main loop. The ID3 pre-scan has
// already refused oversized tags and compressed/encrypted frames.
//
// argv: <input.mp3> <cover-out-path>
// stdout: {"title","artist","album","genre","cover":{"format","size"}|null}

import { writeFileSync } from 'node:fs'
import { parseFile } from 'music-metadata'

const MAX_COVER = 5 * 1024 * 1024
const clip = (s: unknown) => (typeof s === 'string' ? s.replace(/[\p{Cc}]/gu, ' ').trim().slice(0, 200) || null : null)

async function main() {
  const [input, coverOut] = process.argv.slice(2)
  if (!input || !coverOut) process.exit(2)
  const meta = await parseFile(input, { duration: false, skipCovers: false, skipPostHeaders: true, includeChapters: false })
  const c = meta.common
  const pics = c.picture ?? []
  const pic = pics.find((p) => /front/i.test(p.type ?? '')) ?? pics[0]
  let cover: { format: string; size: number } | null = null
  if (pic && pic.data.length > 0 && pic.data.length <= MAX_COVER) {
    writeFileSync(coverOut, pic.data, { flag: 'wx', mode: 0o600 })
    cover = { format: String(pic.format ?? '').slice(0, 64), size: pic.data.length }
  }
  process.stdout.write(
    JSON.stringify({ title: clip(c.title), artist: clip(c.artist), album: clip(c.album), genre: clip(c.genre?.[0]), cover }),
  )
}

main().catch(() => process.exit(3))
