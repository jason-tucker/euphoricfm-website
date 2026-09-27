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
