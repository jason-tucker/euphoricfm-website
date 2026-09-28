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
