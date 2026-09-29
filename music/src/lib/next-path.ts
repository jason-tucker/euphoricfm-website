// v0.4.1: where a signed-out visitor was going (the portal home's ?next=).
// Only a same-origin, relative path is ever accepted: it must start with a
// single '/', hold no backslash or control character, and resolve to the
// portal's own origin. Anything else is ignored (the visitor lands on '/').

const BASE = 'https://portal.invalid'

export function safeNext(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) return null
  if (!v.startsWith('/') || v.startsWith('//')) return null
  if (/[\\\u0000-\u001f\u007f]/.test(v)) return null
  let u: URL
  try {
    u = new URL(v, BASE)
  } catch {
    return null
  }
  if (u.origin !== BASE) return null
  const path = `${u.pathname}${u.search}`
  return path === '/' ? null : path
}

// "Sign in with Discord to open …" on the home page.
export function nextLabel(path: string): string {
  const p = path.split(/[?#]/, 1)[0]!
  if (p === '/submit') return 'Submit songs'
  if (p === '/dashboard') return 'My music'
  if (p === '/library/archived') return 'your archived songs'
  if (p === '/library' || p.startsWith('/library/')) return path.includes('intent=remove') ? 'ask for a song’s removal' : path.includes('intent=edit') ? 'fix a song’s info' : 'the Library'
  if (p.startsWith('/requests/')) return 'your request'
  if (p.startsWith('/batches/')) return 'your batch'
  if (p.startsWith('/review')) return 'the review queue'
  if (p === '/admin') return 'Admin'
  return 'the page you wanted'
}
