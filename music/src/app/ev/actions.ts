'use server'

// Events-site auth actions. Paths are the events host's public paths (the
// middleware rewrites /x to /ev/x), fixed targets only.

import { signIn, signOut } from '@/server/auth/config'

export async function evSignIn() {
  await signIn('discord', { redirectTo: '/' })
}

export async function evSignInToRequest() {
  await signIn('discord', { redirectTo: '/request' })
}

export async function evSignInToMy() {
  await signIn('discord', { redirectTo: '/my' })
}

export async function evSignOut() {
  await signOut({ redirectTo: '/' })
}
