'use server'

// Auth server actions (same-origin form POSTs; Next checks the action's
// Origin, and the portal middleware applies its CSRF gate as well).

import { safeNext } from '@/lib/next-path'
import { signIn, signOut } from '@/server/auth/config'

// v0.4.1: a form may carry `next` (the page a signed-out visitor was sent
// away from); only a same-origin relative path is honoured.
export async function signInWithDiscord(form?: FormData) {
  const next = form instanceof FormData ? safeNext(form.get('next')) : null
  await signIn('discord', { redirectTo: next ?? '/' })
}

export async function signOutAction() {
  await signOut({ redirectTo: '/' })
}

// Home page "Sign in to suggest an edit / request removal": sign in, then
// land on the library with that request type picked. Fixed targets only.
export async function signInToSuggestEdit() {
  await signIn('discord', { redirectTo: '/library?intent=edit' })
}

export async function signInToRequestRemoval() {
  await signIn('discord', { redirectTo: '/library?intent=remove' })
}
