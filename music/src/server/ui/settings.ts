// Read-only view of the settings the UI renders. Unknown or malformed values
// fall back to the UI defaults below; nothing here writes.

import { z } from 'zod'
import type { DB } from '../db/client'
import { dailyCapsOf } from '../requests/service'
import { capsOf, getSetting, getSettings, intListOf, soundcloudEnabledOf } from '../settings'
import type { Caps } from '../settings-defaults'

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
export const DEFAULT_PLAYLIST_NAMES: Record<string, string> = { '2': 'General Rotation' }

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
  // v0.4.0: the "Add from a SoundCloud link" kill switch
  soundcloudEnabled: boolean
  // Edit / removal requests per member per day (the home page's limits).
  requestCaps: { edit: number; removal: number }
}

const rightsOf = (v: unknown) => {
  const r = rightsSchema.safeParse(v)
  return r.success ? r.data : DEFAULT_RIGHTS
}
const inviteOf = (v: unknown): string | null => {
  const r = inviteSchema.safeParse(v)
  return r.success ? r.data : null
}

export async function rightsText(db: DB) {
  return rightsOf(await getSetting(db, UI_SETTING_KEYS.rights))
}

export async function inviteUrl(db: DB): Promise<string | null> {
  return inviteOf(await getSetting(db, UI_SETTING_KEYS.invite))
}

const idsOf = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x) && x > 0).slice(0, 512) : [])

const UI_KEYS = [
  UI_SETTING_KEYS.rights,
  UI_SETTING_KEYS.invite,
  UI_SETTING_KEYS.playlistNames,
  'assignable_playlist_ids',
  'default_playlist_ids',
  'auto_close_days',
  'caps',
  'station_playlist_ids',
  'foreign_playlist_ids',
  'unconfirmed_playlist_ids',
  'soundcloud_fetch_enabled',
  'request_daily_caps',
] as const

// v0.4.1: one settings query (was one per key).
export async function uiSettings(db: DB): Promise<UiSettings> {
  const v = await getSettings(db, UI_KEYS)
  const names = namesSchema.safeParse(v[UI_SETTING_KEYS.playlistNames])
  const autoClose = v.auto_close_days
  return {
    rights: rightsOf(v[UI_SETTING_KEYS.rights]),
    inviteUrl: inviteOf(v[UI_SETTING_KEYS.invite]),
    playlistNames: { ...DEFAULT_PLAYLIST_NAMES, ...(names.success ? names.data : {}) },
    assignablePlaylistIds: intListOf(v.assignable_playlist_ids),
    stationPlaylistIds: idsOf(v.station_playlist_ids),
    foreignPlaylistIds: intListOf(v.foreign_playlist_ids),
    unconfirmedPlaylistIds: idsOf(v.unconfirmed_playlist_ids),
    defaultPlaylistIds: intListOf(v.default_playlist_ids),
    autoCloseDays: typeof autoClose === 'number' && Number.isInteger(autoClose) ? autoClose : 7,
    // The same validated view the server enforces (v0.3.5): stored hard
    // per-file limits (maxUploadBytes, chunkBytes) are ignored, invalid or
    // raised values fall back to the defaults.
    caps: capsOf(v.caps),
    soundcloudEnabled: soundcloudEnabledOf(v.soundcloud_fetch_enabled),
    requestCaps: dailyCapsOf(v.request_daily_caps),
  }
}
