// v0.4.1: the ticket card's /requests/<id> page (A1) and the sign-in round
// trip that keeps where a signed-out visitor was going (A10). The viewer, the
// request headers and the database are mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/server/http/errors'
import { nextLabel, safeNext } from '@/lib/next-path'

type V = { userId: string; discordId: string; name: string; perms: Set<string> }
const state = vi.hoisted(() => ({
  viewer: null as null | { userId: string; discordId: string; name: string; perms: Set<string> },
  path: null as string | null,
  request: null as null | Record<string, unknown>,
  lib: null as null | Record<string, unknown>,
  archived: null as null | Record<string, unknown>,
  signIn: [] as unknown[],
}))

vi.mock('@/server/authz/viewer', () => {
  const requirePermission = vi.fn(async (perm: string) => {
    if (!state.viewer) throw new HttpError(401, 'unauthorized')
    if (!state.viewer.perms.has(perm)) throw new HttpError(403, 'forbidden')
    return state.viewer
  })
  return {
    requirePermission,
    optionalViewer: async () => requirePermission('submit').catch(() => null),
    currentUser: async () => (state.viewer ? { id: state.viewer.userId, discordId: state.viewer.discordId, name: state.viewer.name } : null),
  }
})
vi.mock('next/headers', () => ({ headers: async () => new Headers(state.path ? { 'x-efm-path': state.path } : {}) }))
vi.mock('@/server/db/client', () => ({
  getDb: () => ({
    query: {
      requests: { findFirst: async () => state.request },
      libraryCache: { findFirst: async () => state.lib },
      archive: { findFirst: async () => state.archived },
      memberCache: { findFirst: async () => null },
    },
  }),
}))
vi.mock('@/server/auth/config', () => ({ signIn: vi.fn(async (_p: string, o: unknown) => void state.signIn.push(o)), signOut: vi.fn() }))

const member: V = { userId: 'u1', discordId: '100000000000000001', name: 'Mia', perms: new Set(['submit', 'request']) }
const other: V = { ...member, userId: 'u9', name: 'Other' }
const reviewer: V = { userId: 'u2', discordId: '100000000000000002', name: 'Rev', perms: new Set(['submit', 'request', 'review']) }
const LIB_PATH = 'Music/Artists/GRIM/GRIM - Night.mp3'

beforeEach(() => {
  state.viewer = null
  state.path = null
  state.request = { id: 7, kind: 'edit', status: 'pending', mediaId: 501, ownerUserId: 'u1' }
  state.lib = { mediaId: 501, path: LIB_PATH }
  state.archived = null
  state.signIn = []
})

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'rendered'
  } catch (e) {
    return (e as Error).message
  }
}

describe('GET /requests/<id> (the ticket card link, A1)', async () => {
  const { default: RequestLink } = await import('@/app/requests/[id]/page')
  const open = (id = '7') => outcome(RequestLink({ params: Promise.resolve({ id }) }))

  it('the requester lands on the song page (it lists their requests)', async () => {
    state.viewer = member
    expect(await open()).toBe('NEXT_REDIRECT /library/501')
  })

  it('the requester of an applied removal (song gone from the library) lands on Archived songs', async () => {
    state.viewer = member
    state.request = { ...state.request, kind: 'removal', status: 'done' }
    expect(await open()).toBe('NEXT_REDIRECT /library/archived')
    // still being archived, or the cache row already moved off the surface
    state.request = { ...state.request, kind: 'removal', status: 'verifying' }
    state.archived = { mediaId: 501, status: 'archived' }
    expect(await open()).toBe('NEXT_REDIRECT /library/archived')
    state.archived = null
    state.lib = { mediaId: 501, path: 'Removed/501/GRIM - Night.mp3' }
    expect(await open()).toBe('NEXT_REDIRECT /library/archived')
    state.lib = null
    expect(await open()).toBe('NEXT_REDIRECT /library/archived')
  })

  it('a reviewer lands on the request in the queue', async () => {
    state.viewer = reviewer
    expect(await open()).toBe('NEXT_REDIRECT /review/requests#request-7')
  })

  it('another member (or a request that does not exist, or a malformed id) gets the 404', async () => {
    state.viewer = other
    expect(await open()).toBe('NEXT_NOT_FOUND')
    state.viewer = member
    state.request = null
    expect(await open()).toBe('NEXT_NOT_FOUND')
    expect(await open('7abc')).toBe('NEXT_NOT_FOUND')
    expect(await open('0')).toBe('NEXT_NOT_FOUND')
  })

  it('a signed-out visitor is sent to sign in, and comes back to this link', async () => {
    state.path = '/requests/7'
    expect(await open()).toBe(`NEXT_REDIRECT /?next=${encodeURIComponent('/requests/7')}`)
  })
})

describe('sign-in keeps the destination (A10)', async () => {
  const { pageViewer } = await import('@/server/ui/page')
  const { signInWithDiscord } = await import('@/app/actions')

  it('signed out: /submit, /library/… and /requests/<id> redirect to /?next=<that path>', async () => {
    for (const path of ['/submit', '/library/501?request=edit', '/library?intent=remove', '/requests/7', '/batches/12']) {
      state.path = path
      expect(await outcome(pageViewer('submit'))).toBe(`NEXT_REDIRECT /?next=${encodeURIComponent(path)}`)
    }
    // no usable path header: plain home
    state.path = null
    expect(await outcome(pageViewer('submit'))).toBe('NEXT_REDIRECT /')
    state.path = '//evil.example/x'
    expect(await outcome(pageViewer('submit'))).toBe('NEXT_REDIRECT /')
  })

  it('the sign-in action honours a safe next and ignores anything else', async () => {
    const form = (next?: string) => {
      const f = new FormData()
      if (next !== undefined) f.set('next', next)
      return f
    }
    await signInWithDiscord(form('/library?intent=remove'))
    await signInWithDiscord(form('https://evil.example/'))
    await signInWithDiscord(form())
    await signInWithDiscord()
    expect(state.signIn).toEqual([{ redirectTo: '/library?intent=remove' }, { redirectTo: '/' }, { redirectTo: '/' }, { redirectTo: '/' }])
  })

  it('safeNext accepts only same-origin relative paths', () => {
    expect(safeNext('/library?intent=edit')).toBe('/library?intent=edit')
    expect(safeNext('/requests/7')).toBe('/requests/7')
    expect(safeNext('/a/../submit')).toBe('/submit')
    for (const bad of ['', '/', 'library', 'https://evil.example/', '//evil.example', '/\\evil.example', '/x\ny', 'javascript:alert(1)', 42, null, `/${'a'.repeat(600)}`])
      expect(safeNext(bad), String(bad)).toBeNull()
    expect(safeNext('/%0d%0aX')).toBe('/%0d%0aX') // stays percent-encoded: harmless in a Location header
    expect(nextLabel('/library?intent=remove')).toBe('ask for a song’s removal')
    expect(nextLabel('/submit')).toBe('Submit songs')
    expect(nextLabel('/requests/7')).toBe('your request')
  })
})
