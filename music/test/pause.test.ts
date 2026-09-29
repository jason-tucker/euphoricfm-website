// Contract-drift pause (review finding: the pause must actually stop mutating
// jobs, and the probe must fail closed).
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { AzuraCastClient } from '@/server/azuracast/client'
import { resolveProfile } from '@/server/azuracast/guard'
import { closeDb, getDb } from '@/server/db/client'
import { assertQueuesNotPaused, getQueuesPaused, MUTATING_JOB_KINDS } from '@/server/pause'
import { contractProbe, type WorkerCtx } from '@/worker/handlers'
import { claimJob, IDLE_POLL_MS } from '@/worker/main'
import { DBENV, MOCKS } from './helpers/env'
import { ownerSql } from './helpers/db'
import { control } from './helpers/http'

const ENV = { MUSIC_PROFILE: 'prod', STATION_ID: '1', PORTAL_TEST_PREFIX: 'Portal-Test/' }

function az(baseUrl: string) {
  return new AzuraCastClient({ baseUrl, apiKey: process.env.AZURACAST_API_KEY ?? 'k'.repeat(20), profile: resolveProfile(ENV), canaryStationId: 7, env: ENV })
}

describe('write gate (unit)', () => {
  it('a gate that throws refuses every write and no request leaves', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const c = new AzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(20), profile: resolveProfile(ENV), canaryStationId: 7, env: ENV, fetchImpl })
    c.setWriteGate(async () => {
      throw new Error('queues paused: contract_drift')
    })
    const { createHash } = await import('node:crypto')
    const bytes = Buffer.from('x')
    await expect(c.uploadFile('Portal-Test/Music/Artists/A/a.mp3', bytes, createHash('sha256').update(bytes).digest('hex'))).rejects.toMatchObject({ code: 'refused_queues_paused' })
    await expect(c.setPlaylists('Portal-Test/Music/Artists/A/a.mp3', [2], new Set([2]))).rejects.toMatchObject({ code: 'refused_queues_paused' })
    expect(calls).toHaveLength(0)
  })
})

describe.skipIf(!DBENV() || !MOCKS())('contract probe pauses mutating jobs and fails closed', () => {
  const db = () => getDb(process.env.TEST_APP_DATABASE_URL, 2)
  const alerts: string[] = []
  const ctx = (client: AzuraCastClient) => ({ db: db(), azuracast: client, alert: async (t: string) => void alerts.push(t) }) as unknown as WorkerCtx
  const jobIds: number[] = []

  afterEach(async () => {
    await ownerSql()`UPDATE settings SET value = 'null'::jsonb WHERE key = 'queues_paused'`
    await control('/__mock/az/mode', { superadmin: false, drift: false })
    if (jobIds.length) await ownerSql()`DELETE FROM jobs WHERE id IN ${ownerSql()(jobIds)}`
    jobIds.length = 0
  })
  afterAll(async () => closeDb())

  it('seeded drift: queues_paused is set, and no mutating job is claimed (by this runner or the live worker)', async () => {
    await control('/__mock/az/mode', { drift: true })
    alerts.length = 0
    expect(await contractProbe(ctx(az(process.env.MOCKS_AZURACAST!)))).toBe(false)
    expect(await getQueuesPaused(db())).toMatchObject({ reason: 'contract_drift' })
    expect(alerts.join('\n')).toMatch(/mutating jobs .* paused until an operator clears/)
    await expect(assertQueuesNotPaused(db())).rejects.toThrow(/contract_drift/)

    const tag = `pause-${Date.now()}`
    for (const kind of MUTATING_JOB_KINDS) {
      const [r] = await ownerSql()`INSERT INTO jobs (kind, payload, dedupe_key) VALUES (${kind}, ${ownerSql().json({ tag })}, ${`${tag}:${kind}`}) RETURNING id`
      jobIds.push(Number(r!.id))
    }
    const [n] = await ownerSql()`INSERT INTO jobs (kind, payload, dedupe_key, status) VALUES ('test_nonmutating', '{}', ${`${tag}:n`}, 'queued') RETURNING id`
    jobIds.push(Number(n!.id))
    const claimed: number[] = []
    for (let i = 0; i < 50; i++) {
      const j = await claimJob(db())
      if (!j) break
      claimed.push(Number(j.id))
      // put back anything that is not ours, untouched apart from the claim
      if (!jobIds.includes(Number(j.id))) await ownerSql()`UPDATE jobs SET status = 'queued', locked_at = NULL, attempts = attempts - 1 WHERE id = ${j.id}`
      else await ownerSql()`UPDATE jobs SET status = 'done' WHERE id = ${j.id}`
      if (!jobIds.includes(Number(j.id))) break
    }
    const mutatingIds = jobIds.slice(0, MUTATING_JOB_KINDS.length)
    expect(claimed.filter((id) => mutatingIds.includes(id))).toEqual([])
    // Give the running worker time to try as well: its idle poll backs off
    // from 2 s to IDLE_POLL_MS.max (5 s, v0.4.1), so wait for two of those.
    await new Promise((r) => setTimeout(r, 2 * IDLE_POLL_MS.max + 2000))
    const rows = await ownerSql()`SELECT id, status FROM jobs WHERE id IN ${ownerSql()(mutatingIds)}`
    expect(rows.every((r) => r.status === 'queued')).toBe(true)

    // A successful probe does NOT clear a drift pause.
    await control('/__mock/az/mode', { drift: false })
    expect(await contractProbe(ctx(az(process.env.MOCKS_AZURACAST!)))).toBe(true)
    expect(await getQueuesPaused(db())).toMatchObject({ reason: 'contract_drift' })
  })

  it('a spec that cannot be fetched pauses with contract_unverified; the next good probe resumes', async () => {
    alerts.length = 0
    expect(await contractProbe(ctx(az('http://127.0.0.1:9')))).toBe(false)
    expect(await getQueuesPaused(db())).toMatchObject({ reason: 'contract_unverified' })
    expect(alerts.join('\n')).toMatch(/could not be verified: mutating jobs .* are paused/)
    const retry = await ownerSql()`SELECT id FROM jobs WHERE kind = 'contract_probe' AND dedupe_key LIKE 'contract_probe:retry:%' AND status = 'queued'`
    expect(retry.length).toBeGreaterThan(0)
    for (const r of retry) jobIds.push(Number(r.id))
    expect(await contractProbe(ctx(az(process.env.MOCKS_AZURACAST!)))).toBe(true)
    expect(await getQueuesPaused(db())).toBeNull()
  })
})
