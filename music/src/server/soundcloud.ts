// "Add from a SoundCloud link" (v0.4.0, plan P5), web side.
//
// The web holds no egress to SoundCloud and never talks to music-fetch. It
// only:
//   1. validates the link's SHAPE (src/lib/soundcloud.ts: a public track on
//      soundcloud.com / m.soundcloud.com, or an on.soundcloud.com shortlink;
//      sets, playlists, likes, user pages and anything else are refused with a
//      readable code) and rebuilds it from the validated parts;
//   2. applies the limits: the kill switch (settings.soundcloud_fetch_enabled),
//      a per-member burst limit, at most caps.fetchesPerUserPerDay links per
//      member in any rolling 24 h, at most FETCH_INFLIGHT_PER_USER still being
//      fetched or converted, the batch's own item cap, and the shared staging
//      quota (the link is charged music-fetch's 60 MiB media cap until the
//      worker knows the real size, like a WAV);
//   3. records a 'probing' item (source 'soundcloud', fetch_stage 'queued')
//      with an upload row for the MP3 the probe will publish, and queues a
//      soundcloud_fetch job, all in one transaction under the batch and
//      staging locks.
// The worker writes the music-fetch request (worker/soundcloud.ts). The
// rights attestation is still required when the batch is submitted.

import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { FETCH_INFLIGHT_PER_USER, FETCH_RESERVE_BYTES, parseSoundCloudUrl } from '../lib/soundcloud'
import { audit } from './audit'
import { canViewOwned, isOwner, type Viewer } from './authz/predicates'
import type { DB } from './db/client'
import { batches, items, uploads } from './db/schema'
import { badRequest, conflict, HttpError, notFound } from './http/errors'
import { RateLimiter } from './http/ratelimit'
import { enqueue } from './jobs'
import { loadCaps, soundcloudEnabled } from './settings'
import type { Caps } from './settings-defaults'
import { lockStaging, stagedBytes } from './uploads/caps'

// Per member, in this process (the web runs one instance): a burst limit on
// top of the IP-keyed mutation limiter and the daily cap below.
export const SC_BURST = { name: 'soundcloud', max: 10, windowMs: 60_000 } as const
const burst = new RateLimiter(5_000)

export async function addSoundCloudToBatch(db: DB, v: Viewer, batchId: number, rawUrl: unknown, opts: { caps?: Caps; now?: number } = {}) {
  // Every attempt counts, a refused one too.
  const hit = burst.hit(SC_BURST, v.userId, opts.now)
  if (!hit.ok) throw new HttpError(429, 'sc_rate_limited', undefined, { 'Retry-After': String(hit.retryAfterS) })
  const parsed = parseSoundCloudUrl(rawUrl)
  if (!parsed.ok) throw badRequest(parsed.code)
  if (!(await soundcloudEnabled(db))) throw new HttpError(503, 'sc_disabled')
  const b = await db.query.batches.findFirst({ where: eq(batches.id, batchId) })
  if (!b || !canViewOwned(v, b) || !isOwner(v, b)) throw notFound()
  if (b.status !== 'draft') throw conflict('batch_not_draft')
  const caps = opts.caps ?? (await loadCaps(db))
  const fetchRequestId = randomUUID()
  const uploadId = randomBytes(16).toString('hex')
  const row = await db.transaction(async (tx) => {
    // Same lock order as addUploadToBatch (batch row), then the staging lock
    // every staged-bytes admission takes.
    const [locked] = await tx.select({ status: batches.status }).from(batches).where(eq(batches.id, b.id)).for('update')
    if (locked?.status !== 'draft') throw conflict('batch_not_draft')
    await lockStaging(tx)
    // Serialise one member's links, so the counts below cannot be raced.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('efm-music:soundcloud'), hashtext(${v.userId}))`)
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(items)
      .where(and(eq(items.batchId, b.id), inArray(items.status, ['probing', 'pending', 'draft'])))
    if (n >= caps.maxItemsPerBatch) throw new HttpError(409, 'batch_full')
    const since = new Date((opts.now ?? Date.now()) - 24 * 3600_000)
    // Every link counts, whatever became of it (rejected and withdrawn too),
    // except one that never reached SoundCloud because of the portal
    // (v0.4.1): the kill switch, or the queue timing out.
    const [day] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(items)
      .where(
        and(
          eq(items.ownerUserId, v.userId),
          eq(items.source, 'soundcloud'),
          gte(items.createdAt, since),
          sql`${items.probeError} IS DISTINCT FROM 'sc_disabled' AND ${items.probeError} IS DISTINCT FROM 'sc_queue_timeout'`,
        ),
      )
    if ((day?.n ?? 0) >= caps.fetchesPerUserPerDay) throw new HttpError(429, 'sc_daily_cap', undefined, { 'Retry-After': '3600' })
    const [busy] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(items)
      .where(and(eq(items.ownerUserId, v.userId), eq(items.source, 'soundcloud'), eq(items.status, 'probing')))
    if ((busy?.n ?? 0) >= FETCH_INFLIGHT_PER_USER) throw new HttpError(429, 'sc_busy', undefined, { 'Retry-After': '60' })
    // The shared staging quota and the member's in-flight bytes, like a tus
    // creation (uploads/caps.ts admitUpload).
    const staged = await stagedBytes(tx)
    if (staged.uploads + staged.art + FETCH_RESERVE_BYTES > caps.maxStagingBytes) throw new HttpError(503, 'staging_full', undefined, { 'Retry-After': '600' })
    const [u] = await tx.execute<{ inflight: string }>(
      sql`SELECT COALESCE(SUM(up.length) FILTER (
            WHERE up.status IN ('uploading', 'complete')
               OR (up.status = 'attached' AND EXISTS (
                    SELECT 1 FROM items i WHERE i.upload_id = up.id AND i.status IN ('probing', 'draft', 'pending')))
          ), 0)::bigint AS inflight
          FROM ${uploads} up WHERE up.owner_user_id = ${v.userId}`,
    )
    if (Number(u?.inflight ?? 0) + FETCH_RESERVE_BYTES > caps.maxInflightBytesPerUser) throw new HttpError(429, 'inflight_quota', undefined, { 'Retry-After': '60' })
    // The upload row stands for the MP3 the probe will publish under this id
    // ('attached' at once: nothing is uploaded through tus).
    await tx.insert(uploads).values({ id: uploadId, ownerUserId: v.userId, length: FETCH_RESERVE_BYTES, status: 'attached', completedAt: new Date() })
    const [it] = await tx
      .insert(items)
      .values({
        batchId: b.id,
        ownerUserId: v.userId,
        status: 'probing',
        source: 'soundcloud',
        uploadId,
        fetchRequestId,
        fetchStage: 'queued',
        sourceUrl: parsed.url,
      })
      .returning()
    await enqueue(tx, 'soundcloud_fetch', { itemId: it!.id }, { dedupeKey: `soundcloud_fetch:item:${it!.id}` })
    await audit(tx, {
      actorUserId: v.userId,
      actorDiscordId: v.discordId,
      action: 'item.add_soundcloud',
      targetType: 'item',
      targetId: it!.id,
      detail: { batchId: b.id, url: parsed.url, fetchRequestId },
    })
    return it!
  })
  return { id: row.id, status: row.status, source: row.source, url: parsed.url }
}
