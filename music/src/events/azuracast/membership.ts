// Station-14 playlist membership for event files (plan §4 "Membership
// writes (critical)"). AzuraCast's do=playlist batch REPLACES a file's
// station-14 memberships, and the same library song can sit in several
// events' playlists and in legacy playlists 74–78. So every write is a
// read-merge-write:
//
//   current  = the file's playlist ids from a FRESH GET /file/{id}, kept
//              only if they are station-14 ids (a fresh GET /playlists);
//   desired  = (current − this event's superseded registry ids)
//              ∪ this event's new registry ids that should hold the file;
//   removed  = current − desired, which must be ⊆ this event's registry ids.
//
// The worker runs the whole membership phase under one Postgres advisory
// lock (worker/db.ts withMembershipLock), and the wrapper re-checks the
// rule against its own fresh read right before the batch leaves.

import { assertWritablePlaylistId, LEGACY_PLAYLIST_IDS, PLAYLIST_ID_FLOOR } from './allowlist'
import type { EventsAzuraCastClient } from './client'

export class MembershipError extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'MembershipError'
  }
}

export type MergeResult = { current14: number[]; desired: number[]; added: number[]; removed: number[]; changed: boolean }

export function mergeMembership(opts: {
  current: readonly number[]
  station14Ids: ReadonlySet<number>
  // this event's registry ids being replaced (normally all of them)
  superseded: ReadonlySet<number>
  // this event's registry ids that should hold the file after the write
  add: ReadonlySet<number>
}): MergeResult {
  for (const id of opts.add) {
    assertWritablePlaylistId(id)
    if (!opts.station14Ids.has(id)) throw new MembershipError('add_not_station14', { id })
  }
  for (const id of opts.superseded) {
    if (id <= PLAYLIST_ID_FLOOR || LEGACY_PLAYLIST_IDS.includes(id)) throw new MembershipError('superseded_below_floor', { id })
  }
  const current14 = [...new Set(opts.current.filter((id) => opts.station14Ids.has(id)))].sort((a, b) => a - b)
  const desiredSet = new Set(current14.filter((id) => !opts.superseded.has(id)))
  for (const id of opts.add) desiredSet.add(id)
  const desired = [...desiredSet].sort((a, b) => a - b)
  const added = desired.filter((id) => !current14.includes(id))
  const removed = current14.filter((id) => !desiredSet.has(id))
  for (const id of removed) if (!opts.superseded.has(id)) throw new MembershipError('removed_not_superseded', { id })
  return { current14, desired, added, removed, changed: added.length > 0 || removed.length > 0 }
}

// One file's read-merge-write. `eventIds` = every registry playlist id of
// the event (superseded and removable), `want` = the ids of that event that
// should hold this file now. The caller holds the membership lock.
export async function applyFileMembership(
  client: EventsAzuraCastClient,
  opts: { mediaId: number; path: string; eventIds: ReadonlySet<number>; want: ReadonlySet<number>; station14Ids: ReadonlySet<number>; removalOnly?: boolean },
): Promise<MergeResult | null> {
  const fresh = await client.getFileOrNull(opts.mediaId)
  if (!fresh) return null
  if (fresh.path !== opts.path) throw new MembershipError('stale_path', { mediaId: opts.mediaId, expected: opts.path, actual: fresh.path })
  const m = mergeMembership({ current: fresh.playlists.map((p) => p.id), station14Ids: opts.station14Ids, superseded: opts.eventIds, add: opts.want })
  if (!m.changed) return m
  if (opts.removalOnly && m.added.length > 0) throw new MembershipError('add_on_removal_only', { mediaId: opts.mediaId })
  await client.setMembership(opts.path, m.desired, { mediaId: opts.mediaId, path: opts.path, removable: opts.eventIds, addable: opts.want, removalOnly: opts.removalOnly })
  return m
}
