'use server'

// Auth server actions (same-origin form POSTs; Next checks the action's
// Origin, and the portal middleware applies its CSRF gate as well).

import { signIn, signOut } from '@/server/auth/config'

export async function signInWithDiscord() {
  await signIn('discord', { redirectTo: '/' })
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
