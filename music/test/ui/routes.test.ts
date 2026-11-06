// Route tests for the read-only /api/ui/* endpoints with the viewer, DB and
// library queries mocked (no database needed).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/server/http/errors'

const viewer = vi.hoisted(() => ({ current: null as null | { userId: string; discordId: string; name: string; perms: Set<string> } }))
const lib = vi.hoisted(() => ({
  searchArtists: vi.fn(async () => [{ id: 1, name: 'GRIM', folder: 'GRIM' }, { id: 2, name: 'Spirit', folder: 'Aaron "Spirit" Michaels' }]),
  searchAlbums: vi.fn(async () => [{ album: 'Night Drive', artist: 'GRIM' }]),
  lookupArtist: vi.fn(async () => ({ known: null, proposedFolder: 'New Guy', folderError: null, folderTaken: false })),
  previewFolder: vi.fn(async () => ({ proposedFolder: 'Clean', folderError: null, folderTaken: false })),
  findDuplicates: vi.fn(async () => []),
}))

vi.mock('@/server/authz/viewer', () => ({
  requirePermission: vi.fn(async (perm: string) => {
    if (!viewer.current) throw new HttpError(401, 'unauthorized')
    if (!viewer.current.perms.has(perm)) throw new HttpError(403, 'forbidden')
    return viewer.current
  }),
}))
vi.mock('@/server/db/client', () => ({ getDb: () => ({}) }))
vi.mock('@/server/ui/library', () => lib)

const member = { userId: 'u1', discordId: '100000000000000001', name: 'm', perms: new Set(['submit', 'request']) }
const reviewer = { ...member, userId: 'u2', perms: new Set(['submit', 'request', 'review']) }

async function get(mod: { GET: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }, qs: string) {
  const r = await mod.GET(new Request(`https://music.euphoric.fm/api/ui/x?${qs}`), { params: Promise.resolve({}) })
  return { status: r.status, body: await r.json() }
}

beforeEach(() => {
  viewer.current = member
})

describe('GET /api/ui/library', async () => {
  const mod = await import('@/app/api/ui/library/route')
  it('requires a session (401) and the submit permission (403)', async () => {
    viewer.current = null
    expect((await get(mod, 'field=artist&q=gr')).status).toBe(401)
    viewer.current = { ...member, perms: new Set() }
    expect((await get(mod, 'field=artist&q=gr')).status).toBe(403)
  })
  it('validates field and query length', async () => {
    expect((await get(mod, 'field=path&q=gr')).status).toBe(400)
    expect((await get(mod, 'field=artist&q=g')).status).toBe(400)
    expect((await get(mod, `field=artist&q=${'x'.repeat(101)}`)).status).toBe(400)
  })
  it('returns artist names with their folder as a hint when it differs', async () => {
    const r = await get(mod, 'field=artist&q=gr')
    expect(r.status).toBe(200)
    expect(r.body.results).toEqual([{ value: 'GRIM' }, { value: 'Spirit', hint: 'Folder: Aaron "Spirit" Michaels' }])
  })
  it('returns albums', async () => {
    expect((await get(mod, 'field=album&q=night')).body.results).toEqual([{ value: 'Night Drive', hint: 'GRIM' }])
  })
})

describe('GET /api/ui/artist', async () => {
  const mod = await import('@/app/api/ui/artist/route')
  it('name lookup is open to members', async () => {
    const r = await get(mod, 'name=New%20Guy')
    expect(r.status).toBe(200)
    expect(r.body.proposedFolder).toBe('New Guy')
  })
  it('the folder preview is reviewer-only', async () => {
    expect((await get(mod, 'folder=x')).status).toBe(403)
    viewer.current = reviewer
    expect((await get(mod, 'folder=x')).body).toEqual({ known: null, proposedFolder: 'Clean', folderError: null, folderTaken: false })
  })
  it('an empty name is a 400', async () => {
    expect((await get(mod, 'name=%20')).status).toBe(400)
  })
})

describe('GET /api/ui/duplicates', async () => {
  const mod = await import('@/app/api/ui/duplicates/route')
  it('passes the viewer through (member scoping happens in findDuplicates) and validates input', async () => {
    expect((await get(mod, 'title=T&artist=A&item=5')).status).toBe(200)
    expect(lib.findDuplicates).toHaveBeenCalledWith({}, member, 'T', 'A', 5)
    expect((await get(mod, 'title=&artist=A')).status).toBe(400)
    expect((await get(mod, 'title=T&artist=A&item=abc')).status).toBe(400)
  })
})
