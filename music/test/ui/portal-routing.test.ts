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

// What a page did: 'NEXT_REDIRECT <url>', 'NEXT_NOT_FOUND' or 'rendered'.
// The real next/navigation (the harness, which has no jsdom setup file)
// throws errors whose digest is 'NEXT_REDIRECT;<type>;<url>;<status>;' or
// 'NEXT_HTTP_ERROR_FALLBACK;404'; test/ui/setup.ts's stub (pnpm test:ui)
// throws messages already in the short form.
export function navOutcome(e: unknown): string {
  const digest = (e as { digest?: unknown } | null)?.digest
  if (typeof digest === 'string') {
    const parts = digest.split(';')
    if (parts[0] === 'NEXT_REDIRECT') return `NEXT_REDIRECT ${parts.slice(2, -2).join(';')}`
    if ((parts[0] === 'NEXT_HTTP_ERROR_FALLBACK' && parts[1] === '404') || parts[0] === 'NEXT_NOT_FOUND') return 'NEXT_NOT_FOUND'
  }
  return (e as Error).message
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'rendered'
  } catch (e) {
    return navOutcome(e)
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
    state.path = '/..//evil.example/x'
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
    await signInWithDiscord(form('/..//evil.example')) // v0.4.1 review: resolves to '//evil.example'
    expect(state.signIn).toEqual([{ redirectTo: '/library?intent=remove' }, { redirectTo: '/' }, { redirectTo: '/' }, { redirectTo: '/' }, { redirectTo: '/' }])
  })

  it('the outcome helper reads the real Next digests too', () => {
    expect(navOutcome(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/library/501;307;' }))).toBe('NEXT_REDIRECT /library/501')
    expect(navOutcome(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/?next=%2Fa;b;307;' }))).toBe('NEXT_REDIRECT /?next=%2Fa;b')
    expect(navOutcome(Object.assign(new Error('x'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }))).toBe('NEXT_NOT_FOUND')
    expect(navOutcome(new Error('NEXT_REDIRECT /x'))).toBe('NEXT_REDIRECT /x')
  })

  it('safeNext accepts only same-origin relative paths', () => {
    expect(safeNext('/library?intent=edit')).toBe('/library?intent=edit')
    expect(safeNext('/requests/7')).toBe('/requests/7')
    expect(safeNext('/a/../submit')).toBe('/submit')
    for (const bad of ['', '/', 'library', 'https://evil.example/', '//evil.example', '/\\evil.example', '/x\ny', 'javascript:alert(1)', 42, null, `/${'a'.repeat(600)}`])
      expect(safeNext(bad), String(bad)).toBeNull()
    expect(safeNext('/%0d%0aX')).toBe('/%0d%0aX') // stays percent-encoded: harmless in a Location header
    // security review (v0.4.1): dot segments resolved to a '//host' path were
    // an open redirect for a signed-in visitor (/?next=/..//evil.example →
    // Location: //evil.example); /api is never a sign-in destination
    for (const bad of ['/..//evil.example', '/.//evil.example', '/a/..//evil.example', '/.%2e//evil.example', '/%2e%2e//evil.example/x?y=1', '/api', '/api/items/1', '/API/x', '/a/../api/x'])
      expect(safeNext(bad), bad).toBeNull()
    expect(safeNext('/./submit')).toBe('/submit')
    expect(safeNext('/%2F/evil.example')).toBe('/%2F/evil.example') // an encoded slash stays a path on this origin
    expect(safeNext('/apidocs')).toBe('/apidocs')
    expect(nextLabel('/library?intent=remove')).toBe('ask for a song’s removal')
    expect(nextLabel('/submit')).toBe('Submit songs')
    expect(nextLabel('/requests/7')).toBe('your request')
  })
})
