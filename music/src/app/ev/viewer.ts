// Server-side viewer for events pages: the portal's session (same Auth.js
// setup, own cookie on the events host) mapped to what the events UI needs.

import type { Viewer } from '@/server/authz/predicates'
import { headerViewer } from '@/server/ui/page'
import type { BarViewer } from '@/events/components/EventsBar'

export type EvViewer = NonNullable<BarViewer> & { userId: string; member: boolean }

export function toEvViewer(v: Viewer | null): EvViewer | null {
  if (!v) return null
  return {
    userId: v.userId,
    discordId: v.discordId,
    name: v.name,
    member: v.perms.has('submit'),
    review: v.perms.has('review'),
    manage: v.perms.has('manage'),
    admin: v.perms.has('admin'),
  }
}

export async function evViewer(): Promise<EvViewer | null> {
  try {
    return toEvViewer(await headerViewer())
  } catch {
    return null
  }
}
