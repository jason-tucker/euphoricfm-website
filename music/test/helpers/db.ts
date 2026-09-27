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

// STUB of the foundation's art_uploads table (art contract column names),
// so P4 art tests run before that migration lands. IF NOT EXISTS: the real
// table wins once merged.
export async function ensureArtUploadsStub() {
  await ownerSql().unsafe(`CREATE TABLE IF NOT EXISTS art_uploads (
    id text PRIMARY KEY, owner text NOT NULL, status text NOT NULL, reason text,
    raw_path text, jpeg_path text, jpeg_sha256 text, created_at timestamptz NOT NULL DEFAULT now())`)
  await ownerSql().unsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON art_uploads TO music_app')
}

export async function insertArt(owner: string, status = 'ready'): Promise<{ id: string; jpegPath: string; sha: string }> {
  const id = crypto.randomUUID()
  const sha = Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64)
  const jpegPath = `/staging/art/${id}/art.jpg`
  await ownerSql()`INSERT INTO art_uploads (id, owner, status, jpeg_path, jpeg_sha256) VALUES (${id}, ${owner}, ${status}, ${jpegPath}, ${sha})`
  return { id, jpegPath, sha }
}
