// v0.4.1 (A7a, A7c): the order in which the probe takes spool requests, and
// its spool sweep. Plain temp directories; no ffmpeg, no database.
import { randomUUID } from 'node:crypto'
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextJob, SPOOL_SWEEP_MAX_AGE_MS, sweepSpool } from '@/probe/main'
import { listSpoolIds, writeSpoolRequest, type SpoolRequest } from '@/server/spool/protocol'

let spool: string
const T0 = Date.UTC(2031, 0, 1, 12) / 1000

beforeEach(() => {
  spool = mkdtempSync(join(tmpdir(), 'probe-order-'))
  for (const d of ['in-web', 'in-worker', 'claimed', 'out']) mkdirSync(join(spool, d))
})

// Writes a request with a given arrival time (mtime, seconds after T0).
async function put(inbox: 'in-web' | 'in-worker', req: SpoolRequest, atS: number): Promise<string> {
  await writeSpoolRequest(join(spool, inbox), req)
  utimesSync(join(spool, inbox, `${req.id}.json`), T0 + atS, T0 + atS)
  return req.id
}
const hex = (n: number, c = 'a') => c.repeat(n)
const probeFetch = (id = randomUUID()): SpoolRequest => ({
  v: 1,
  id,
  type: 'probe_fetch',
  fetchId: id,
  upload: hex(32, 'b'),
  ext: 'm4a',
  format: 'mp4',
  sha256: hex(64),
  size: 1000,
  artworkSha256: null,
  declaredDurationS: 240,
})
const finalize = (id = randomUUID()): SpoolRequest => ({
  v: 1,
  id,
  type: 'finalize',
  upload: hex(32, 'c'),
  approvedSha256: hex(64),
  tags: { title: 'T', artist: 'A', album: '', genre: '' },
  cover: null,
})
const probe = (id = randomUUID()): SpoolRequest => ({ v: 1, id, type: 'probe', upload: hex(32, 'd'), expectedSize: 1000 })
const take = (inbox: string, id: string) => rmSync(join(spool, inbox, `${id}.json`))

describe('probe request order (A7a)', () => {
  it('each inbox is taken oldest first (mtime), not in UUID order', async () => {
    const late = await put('in-web', probe('00000000-0000-4000-8000-000000000001'), 20)
    const early = await put('in-web', probe('ffffffff-ffff-4fff-bfff-ffffffffffff'), 10)
    expect(await listSpoolIds(join(spool, 'in-web'))).toEqual([early, late])
    expect(await nextJob(spool, 'in-web')).toEqual({ inbox: 'in-web', id: early })
  })

  it('with 3 SoundCloud conversions queued, a finalize written after them runs first', async () => {
    const convs = [await put('in-worker', probeFetch(), 1), await put('in-worker', probeFetch(), 2), await put('in-worker', probeFetch(), 3)]
    const fin = await put('in-worker', finalize(), 4)
    const web = await put('in-web', probe(), 0)
    expect(await nextJob(spool, 'in-worker')).toEqual({ inbox: 'in-worker', id: fin })
    expect(await nextJob(spool, 'in-web')).toEqual({ inbox: 'in-worker', id: fin }) // ahead of the web too
    take('in-worker', fin)
    // then the rest alternates, oldest first in each inbox
    expect(await nextJob(spool, 'in-web')).toEqual({ inbox: 'in-web', id: web })
    expect(await nextJob(spool, 'in-worker')).toEqual({ inbox: 'in-worker', id: convs[0] })
    take('in-web', web)
    expect(await nextJob(spool, 'in-web')).toEqual({ inbox: 'in-worker', id: convs[0] }) // nothing in-web: no idle turn
  })

  it('a cleanup_final is urgent too, and runs after an older finalize', async () => {
    await put('in-worker', probeFetch(), 1)
    const fin = await put('in-worker', finalize(), 2)
    const clean = await put('in-worker', { v: 1, id: randomUUID(), type: 'cleanup_final', file: `${randomUUID()}.mp3` }, 3)
    expect((await nextJob(spool, 'in-web'))!.id).toBe(fin)
    take('in-worker', fin)
    expect((await nextJob(spool, 'in-web'))!.id).toBe(clean)
  })

  it('a request that cannot be read is taken at once (it is answered bad_request, never run)', async () => {
    await put('in-worker', probeFetch(), 1)
    const bad = randomUUID()
    writeFileSync(join(spool, 'in-worker', `${bad}.json`), '{not json')
    utimesSync(join(spool, 'in-worker', `${bad}.json`), T0 + 5, T0 + 5)
    expect(await nextJob(spool, 'in-web')).toEqual({ inbox: 'in-worker', id: bad })
  })

  it('empty inboxes: nothing to do', async () => {
    expect(await nextJob(spool, 'in-web')).toBeNull()
  })
})

describe('probe spool sweep (A7c)', () => {
  it('removes results and .tmp-* older than a day; keeps fresh ones, requests and other names; never follows a link', async () => {
    const now = Date.now()
    const old = (p: string) => {
      writeFileSync(p, '{}')
      const t = (now - SPOOL_SWEEP_MAX_AGE_MS - 60_000) / 1000
      utimesSync(p, t, t)
      return p
    }
    const oldResult = old(join(spool, 'out', `${randomUUID()}.json`))
    const fresh = join(spool, 'out', `${randomUUID()}.json`)
    writeFileSync(fresh, '{}')
    const tmps = [old(join(spool, 'out', '.tmp-aa')), old(join(spool, 'claimed', '.tmp-bb')), old(join(spool, 'in-web', '.tmp-cc')), old(join(spool, 'in-worker', '.tmp-dd'))]
    const queued = old(join(spool, 'in-worker', `${randomUUID()}.json`)) // an old REQUEST is never swept
    const other = old(join(spool, 'out', 'README.json'))
    const decoy = old(join(spool, '..', `decoy-${randomUUID()}.json`))
    symlinkSync(decoy, join(spool, 'out', '.tmp-link'))
    const t = (now - SPOOL_SWEEP_MAX_AGE_MS - 60_000) / 1000
    lutimesSync(join(spool, 'out', '.tmp-link'), t, t)
    const n = await sweepSpool(spool, now)
    expect(n).toBe(6) // the old result, four tmp files and the tmp link
    expect(existsSync(oldResult)).toBe(false)
    for (const t of tmps) expect(existsSync(t)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(queued)).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(decoy)).toBe(true)
    expect(readdirSync(join(spool, 'out')).sort()).toEqual([fresh.split('/').pop(), 'README.json'].sort())
  })
})
