import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import postgres from 'postgres'

let owner: postgres.Sql | null = null
let app: postgres.Sql | null = null

export function ownerSql() {
  owner ??= postgres(process.env.TEST_OWNER_DATABASE_URL!, { max: 2, onnotice: () => {} })
  return owner
}
export function appSql() {
  app ??= postgres(process.env.TEST_APP_DATABASE_URL!, { max: 2, onnotice: () => {} })
  return app
}

// Force the next membership check (TTL) by ageing the cache row.
export async function ageMemberCache(discordId: string, seconds: number) {
  await ownerSql()`UPDATE member_cache SET checked_at = now() - make_interval(secs => ${seconds}) WHERE discord_id = ${discordId}`
}

// A row in the foundation's art_uploads (owner = users.id, status enum,
// absolute probe-published jpeg_path /staging/art/<id>/cover.jpg). With
// `artDir`, a ready row also gets real JPEG bytes at <artDir>/<id>/cover.jpg
// (the wrapper's uploadArt reads and re-hashes them); jpeg_sha256 is their
// sha256. Without it, the row alone (web-side validation tests).
export async function insertArt(owner: string, status = 'ready', artDir?: string): Promise<{ id: string; jpegPath: string; sha: string; bytes: Buffer }> {
  const id = crypto.randomUUID()
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`test art ${id}`), Buffer.from([0xff, 0xd9])])
  const sha = createHash('sha256').update(bytes).digest('hex')
  const jpegPath = `${artDir ?? '/staging/art'}/${id}/cover.jpg`
  if (artDir && status === 'ready') {
    mkdirSync(`${artDir}/${id}`, { recursive: true })
    writeFileSync(jpegPath, bytes)
  }
  await ownerSql()`INSERT INTO art_uploads (id, owner, status, jpeg_path, jpeg_sha256) VALUES (${id}, ${owner}, ${status}::art_status, ${status === 'ready' ? jpegPath : null}, ${status === 'ready' ? sha : null})`
  return { id, jpegPath, sha, bytes }
}
