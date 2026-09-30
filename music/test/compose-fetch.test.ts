// v0.4.0 music-fetch in the PRODUCTION compose definitions (compose.yml as
// resolved by `docker compose config`: test/run.sh renders it into
// /data/compose.prod.json; the test overlay is NOT applied). The mount checks
// in run.sh exercise the same definitions on the running containers.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { has } from './helpers/env'

type Svc = {
  image?: string
  read_only?: boolean
  init?: boolean
  cap_drop?: string[]
  cap_add?: string[]
  security_opt?: string[]
  labels?: Record<string, string>
  mem_limit?: string | number
  memswap_limit?: string | number
  pids_limit?: number
  env_file?: unknown
  environment?: Record<string, string>
  networks?: Record<string, unknown>
  network_mode?: string
  ports?: unknown[]
  volumes?: { type: string; source: string; target: string; read_only?: boolean }[]
}
type Cfg = { services: Record<string, Svc>; networks: Record<string, { driver?: string; driver_opts?: Record<string, string>; enable_ipv6?: boolean; ipam?: { config?: { subnet?: string }[] } }> }

const file = () => join(process.env.TEST_DATA_DIR ?? '/nonexistent', 'compose.prod.json')
const ready = () => has('TEST_DATA_DIR') && (existsSync(file()) || process.env.REQUIRE_ALL === '1')

const mounts = (s: Svc) => (s.volumes ?? []).map((v) => `${v.source.replace(/^.*\/(staging|spool)\//, '$1/')}:${v.target}:${v.read_only ? 'ro' : 'rw'}`).sort()

describe.skipIf(!ready())('compose.yml: music-fetch (v0.4.0)', () => {
  const cfg = (): Cfg => JSON.parse(readFileSync(file(), 'utf8'))

  it('is hardened like the other services and holds nothing', () => {
    const f = cfg().services['music-fetch']!
    expect(f.image).toMatch(/^ghcr\.io\/jason-tucker\/euphoricfm-website-music:fetch-/)
    expect(f).toMatchObject({ read_only: true, init: true, cap_drop: ['ALL'], pids_limit: 64 })
    expect(f.security_opt).toContain('no-new-privileges:true')
    expect(f.cap_add ?? []).toEqual([])
    expect(f.labels?.['com.centurylinklabs.watchtower.enable']).toBe('false')
    expect(Number(f.mem_limit)).toBeGreaterThan(0)
    expect(Number(f.mem_limit)).toBeLessThanOrEqual(256 * 1024 * 1024)
    expect(f.memswap_limit).toEqual(f.mem_limit)
    expect(f.env_file ?? []).toEqual([])
    expect(f.environment ?? {}).toEqual({})
    expect(f.ports ?? []).toEqual([])
  })

  it('is on fetch-egress ONLY (pinned 172.31.251.0/24, bridge br-efm-fetch, no IPv6), which no other service joins', () => {
    const c = cfg()
    expect(Object.keys(c.services['music-fetch']!.networks ?? {})).toEqual(['fetch-egress'])
    const n = c.networks['fetch-egress']!
    expect(n.ipam?.config?.[0]?.subnet).toBe('172.31.251.0/24')
    expect(n.driver_opts?.['com.docker.network.bridge.name']).toBe('br-efm-fetch')
    expect(n.enable_ipv6 ?? false).toBe(false)
    for (const [name, s] of Object.entries(c.services)) if (name !== 'music-fetch') expect(Object.keys(s.networks ?? {}), name).not.toContain('fetch-egress')
    expect(c.networks['music-int']).toMatchObject({ internal: true })
  })

  // The botvps host firewall (efm-music-egress: EFM-MUSIC-EGRESS /
  // EFM-MUSIC-TAILNET) keys on these addresses; the test overlay drops them,
  // so only this static check sees them.
  it('address pins the host firewall keys on: music-web 172.31.250.10 on efm-music-hooks, worker-egress 172.31.252.0/24 with exactly its current members', () => {
    const c = cfg()
    expect(c.services['music-web']!.networks?.['efm-music-hooks']).toMatchObject({ ipv4_address: '172.31.250.10' })
    expect(c.networks['worker-egress']!.ipam?.config?.[0]?.subnet).toBe('172.31.252.0/24')
    const onEgress = Object.entries(c.services)
      .filter(([, s]) => Object.keys(s.networks ?? {}).includes('worker-egress'))
      .map(([name]) => name)
    // The botvps egress guard matches the bridge, so every member gets the
    // same private-range / tailnet / INPUT drops; a new member is a review
    // point, hence the exact list.
    expect(onEgress.sort()).toEqual(['events-web', 'events-worker', 'music-worker'])
  })

  it('pinned mounts: fetch rw on its spool + staging; worker in rw / out ro; probe staging/fetch ro; web none', () => {
    const s = cfg().services
    expect(mounts(s['music-fetch']!)).toEqual(['spool/fetch:/spool/fetch:rw', 'staging/fetch:/staging/fetch:rw'])
    expect(mounts(s['music-worker']!)).toEqual(expect.arrayContaining(['spool/fetch/in:/spool/fetch/in:rw', 'spool/fetch/out:/spool/fetch/out:ro']))
    expect(mounts(s['music-worker']!).filter((m) => m.includes('fetch'))).toHaveLength(2)
    expect(mounts(s['music-probe']!)).toEqual(expect.arrayContaining(['staging/fetch:/staging/fetch:ro']))
    expect(mounts(s['music-probe']!).filter((m) => m.includes('fetch'))).toHaveLength(1)
    expect(mounts(s['music-web']!).filter((m) => m.includes('fetch'))).toEqual([])
    expect(s['music-probe']!.network_mode).toBe('none')
  })
})
