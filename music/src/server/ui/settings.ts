// Read-only view of the settings the UI renders. Unknown or malformed values
// fall back to the UI defaults below; nothing here writes.

import { z } from 'zod'
import type { DB } from '../db/client'
import { getIntList, getSetting } from '../settings'
import { DEFAULT_CAPS, type Caps } from '../settings-defaults'

// Keys the UI reads that the foundation seed does not create yet. Admins
// edit them through the settings form (see the report: PUT /api/admin/settings).
export const UI_SETTING_KEYS = {
  rights: 'rights_attestation',
  invite: 'discord_invite_url',
  playlistNames: 'playlist_names',
} as const

export const DEFAULT_RIGHTS = {
  version: '2026-09-27',
  text:
    'I own this recording, or I have permission from everyone who holds rights in it, to have it played on EuphoricFM. ' +
    'I understand managers can decline it, and that it can be removed from rotation later.',
}

// Only playlist 2 is known by name for sure (plan §0). Anything else shows
// as "Playlist #id" until an admin names it.
export const DEFAULT_PLAYLIST_NAMES: Record<string, string> = { '2': '1General Rotation' }

const rightsSchema = z.object({ version: z.string().min(1).max(40), text: z.string().min(1).max(2000) })
const namesSchema = z.record(z.string().regex(/^\d+$/), z.string().max(100))
const inviteSchema = z
  .string()
  .url()
  .refine((u) => /^https:\/\/(discord\.gg|discord\.com)\//.test(u), 'discord invite')

export type UiSettings = {
  rights: { version: string; text: string }
  inviteUrl: string | null
  playlistNames: Record<string, string>
  assignablePlaylistIds: number[]
  // Sync-owned (read-only); foreignPlaylistIds is the admin control.
  stationPlaylistIds: number[]
  foreignPlaylistIds: number[]
  unconfirmedPlaylistIds: number[]
  defaultPlaylistIds: number[]
  autoCloseDays: number
  caps: Caps
}

export async function rightsText(db: DB) {
  const r = rightsSchema.safeParse(await getSetting(db, UI_SETTING_KEYS.rights))
  return r.success ? r.data : DEFAULT_RIGHTS
}

export async function inviteUrl(db: DB): Promise<string | null> {
  const r = inviteSchema.safeParse(await getSetting(db, UI_SETTING_KEYS.invite))
  return r.success ? r.data : null
}

const idsOf = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x) && x > 0).slice(0, 512) : [])

export async function uiSettings(db: DB): Promise<UiSettings> {
  const [rights, invite, namesRaw, assignable, defaults, autoClose, capsRaw, station, foreign, unconfirmed] = await Promise.all([
    rightsText(db),
    inviteUrl(db),
    getSetting(db, UI_SETTING_KEYS.playlistNames),
    getIntList(db, 'assignable_playlist_ids'),
    getIntList(db, 'default_playlist_ids'),
    getSetting(db, 'auto_close_days'),
    getSetting(db, 'caps'),
    getSetting(db, 'station_playlist_ids').then(idsOf),
    getIntList(db, 'foreign_playlist_ids'),
    getSetting(db, 'unconfirmed_playlist_ids').then(idsOf),
  ])
  const names = namesSchema.safeParse(namesRaw)
  const caps = z.object({}).passthrough().safeParse(capsRaw)
  return {
    rights,
    inviteUrl: invite,
    playlistNames: { ...DEFAULT_PLAYLIST_NAMES, ...(names.success ? names.data : {}) },
    assignablePlaylistIds: assignable,
    stationPlaylistIds: station,
    foreignPlaylistIds: foreign,
    unconfirmedPlaylistIds: unconfirmed,
    defaultPlaylistIds: defaults,
    autoCloseDays: typeof autoClose === 'number' && Number.isInteger(autoClose) ? autoClose : 7,
    caps: { ...DEFAULT_CAPS, ...(caps.success ? (caps.data as Partial<Caps>) : {}) } as Caps,
  }
}
