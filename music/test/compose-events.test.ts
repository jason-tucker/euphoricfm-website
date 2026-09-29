// v0.5.0 events services in the PRODUCTION compose definitions (compose.yml
// as resolved by `docker compose config`; test/run.sh renders it into
// /data/compose.prod.json with empty env files; the test overlay is NOT
// applied). run.sh's mount checks exercise the same definitions live.
// [W0]: compose + init-dirs only.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { has } from './helpers/env'

type Svc = {
  image?: string
  command?: string[]
  read_only?: boolean
  init?: boolean
  cap_drop?: string[]
  cap_add?: string[]
  security_opt?: string[]
  labels?: Record<string, string>
  mem_limit?: string | number
  memswap_limit?: string | number
  pids_limit?: number
  cpu_shares?: number
  environment?: Record<string, string>
  networks?: Record<string, unknown>
  network_mode?: string
  ports?: { host_ip?: string; target: number; published: string | number }[]
  tmpfs?: string[]
  depends_on?: Record<string, { condition: string }>
  volumes?: { type: string; source: string; target: string; read_only?: boolean }[]
}
type Cfg = { services: Record<string, Svc>; networks: Record<string, { external?: boolean; internal?: boolean; ipam?: { config?: { subnet?: string }[] } }> }

const file = () => join(process.env.TEST_DATA_DIR ?? '/nonexistent', 'compose.prod.json')
const ready = () => has('TEST_DATA_DIR') && (existsSync(file()) || process.env.REQUIRE_ALL === '1')
const MiB = 1024 * 1024

// "<tree>/<sub>:<target>:<ro|rw>" with <tree> = events/… or the music tree.
const mounts = (s: Svc) =>
  (s.volumes ?? [])
    .map((v) => {
      const m = /\/((?:events\/)?(?:staging|spool)(?:\/.*)?)$/.exec(v.source)
      return `${m ? m[1] : v.source}:${v.target}:${v.read_only ? 'ro' : 'rw'}`
    })
    .sort()

describe.skipIf(!ready())('compose.yml: events services (v0.5.0)', () => {
  const cfg = (): Cfg => JSON.parse(readFileSync(file(), 'utf8'))

  it('[W0] same images as music, hardened, watchtower off, hard memory caps', () => {
    const s = cfg().services
    const img = (svc: string) => s[svc]!.image!.replace(/-[^-:]+$/, '')
    expect(s['events-web']!.image).toMatch(/:web-/)
    expect(s['events-worker']!.image).toMatch(/:worker-/)
    expect(s['events-probe']!.image).toMatch(/:probe-/)
    expect(s['events-web']!.image).toBe(s['music-web']!.image)
    expect(s['events-worker']!.image).toBe(s['music-worker']!.image)
    expect(s['events-probe']!.image).toBe(s['music-probe']!.image)
    expect(img('events-web')).toBe(img('music-web'))
    for (const n of ['events-web', 'events-worker', 'events-probe']) {
      const x = s[n]!
      expect(x, n).toMatchObject({ read_only: true, init: true, cap_drop: ['ALL'] })
      expect(x.cap_add ?? [], n).toEqual([])
      expect(x.security_opt, n).toContain('no-new-privileges:true')
      expect(x.labels?.['com.centurylinklabs.watchtower.enable'], n).toBe('false')
      expect(x.memswap_limit, n).toEqual(x.mem_limit)
    }
    expect(Number(s['events-web']!.mem_limit)).toBe(192 * MiB)
    expect(Number(s['events-worker']!.mem_limit)).toBe(160 * MiB)
    expect(Number(s['events-probe']!.mem_limit)).toBe(256 * MiB)
    expect(s['events-web']!.environment).toMatchObject({ PORTAL_SITE: 'events', NODE_OPTIONS: '--max-old-space-size=128' })
    expect(s['events-worker']!.environment).toMatchObject({ NODE_OPTIONS: '--max-old-space-size=96' })
    expect(s['events-worker']!.command).toEqual(['node', '/app/events-worker.mjs'])
    expect(s['events-probe']).toMatchObject({ pids_limit: 128, cpu_shares: 256, network_mode: 'none' })
    // the probe's start-up mkdir of /staging/art lands on a tiny tmpfs, not on disk
    expect(s['events-probe']!.tmpfs).toEqual(expect.arrayContaining([expect.stringMatching(/^\/staging\/art:size=1m,/)]))
  })

  // (`config` inlines env_file contents into environment; run.sh renders
  // with empty env files, so what is left is compose.yml's own environment.)
  it('[W0] no secrets in compose itself; the probe gets HOME and the 3 s minimum only; web on 127.0.0.1:6097 only', () => {
    const s = cfg().services
    expect(Object.keys(s['events-web']!.environment ?? {}).sort()).toEqual(['HOSTNAME', 'NODE_OPTIONS', 'PORTAL_SITE'])
    expect(Object.keys(s['events-worker']!.environment ?? {})).toEqual(['NODE_OPTIONS'])
    // PROBE_MIN_DURATION_S=3: short announcements; music-probe keeps 30 (unset).
    expect(s['events-probe']!.environment).toEqual({ HOME: '/tmp', PROBE_MIN_DURATION_S: '3' })
    expect(s['music-probe']!.environment ?? {}).not.toHaveProperty('PROBE_MIN_DURATION_S')
    expect(s['events-web']!.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1', target: 3000, published: '6097' })])
    expect(s['events-worker']!.ports ?? []).toEqual([])
    expect(s['events-web']!.depends_on).toMatchObject({ 'music-init': { condition: 'service_completed_successfully' }, 'music-migrate': { condition: 'service_completed_successfully' } })
    expect(s['events-worker']!.depends_on).toMatchObject({ 'music-init': { condition: 'service_completed_successfully' }, 'music-migrate': { condition: 'service_completed_successfully' } })
  })

  it('[W0] networks: web = music-int + worker-egress; worker adds efm-public-net; probe none; pinned subnets unchanged', () => {
    const c = cfg()
    const nets = (n: string) => Object.keys(c.services[n]!.networks ?? {}).sort()
    expect(nets('events-web')).toEqual(['music-int', 'worker-egress'])
    expect(nets('events-worker')).toEqual(['efm-public-net', 'music-int', 'worker-egress'])
    expect(nets('events-probe')).toEqual([])
    expect(c.networks['worker-egress']!.ipam?.config?.[0]?.subnet).toBe('172.31.252.0/24')
    expect(c.networks['efm-public-net']).toMatchObject({ external: true })
    expect(c.networks['music-int']).toMatchObject({ internal: true })
  })

  it('[W0] pinned mounts: the events tree only, nothing of music’s', () => {
    const s = cfg().services
    expect(mounts(s['events-web']!)).toEqual([
      'events/spool/probe/in-web:/spool/probe/in-web:rw',
      'events/spool/probe/out:/spool/probe/out:ro',
      'events/staging/uploads:/staging/uploads:rw',
    ])
    expect(mounts(s['events-worker']!)).toEqual([
      'events/spool/probe/in-worker:/spool/probe/in-worker:rw',
      'events/spool/probe/out:/spool/probe/out:ro',
      'events/staging/final:/staging/final:ro',
    ])
    expect(mounts(s['events-probe']!)).toEqual([
      'events/spool/probe:/spool/probe:rw',
      'events/staging/final:/staging/final:rw',
      'events/staging/uploads:/staging/uploads:rw',
      'events/staging/work:/staging/work:rw',
    ])
    // and no music service mounts anything of the events tree
    for (const n of ['music-web', 'music-worker', 'music-probe', 'music-fetch']) for (const m of mounts(s[n]!)) expect(m, n).not.toMatch(/^events\//)
  })
})
