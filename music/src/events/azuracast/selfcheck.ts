// Events worker start-up self-check (plan §4, last bullet):
//   * the events key reads station 14 (200);
//   * every canary station (EVENTS_CANARY_STATION_IDS, default 1 and 7)
//     answers 403, proving the key is station-scoped (station 1 shares
//     storage 2 with station 14);
//   * ingest is refused while a station-14 playlist has a folder link that
//     covers where uploads land (Events/, Events/Uploads/, an owner folder):
//     AzuraCast's CheckFolderPlaylistsTask would put custom audio on air.
//
// Station 1's folder links are NOT readable with the events key (its reads
// must 403). The ingest verify therefore also re-reads every freshly
// ingested file after the folder-playlist task has run and requires it to
// be in no playlist on any station (jobs/audio.ts), which catches a
// station-1 link by its effect.

import { EVENTS_UPLOAD_DIR } from './allowlist'
import { EventsAzuraCastError, type EventsAzuraCastClient, type ListEntryRead } from './client'

export async function keySelfCheck(client: EventsAzuraCastClient): Promise<void> {
  const own = await client.ownStationReadStatus()
  if (own !== 200) throw new EventsAzuraCastError('self_check_own_station', { status: own })
  for (const sid of client.canaryStationIds) {
    const status = await client.canaryReadStatus(sid)
    if (status !== 403) throw new EventsAzuraCastError('self_check_canary_not_403', { station: sid, status })
  }
}

function dirLinks(e: ListEntryRead | undefined): unknown[] {
  if (!e) return []
  const dir = (e as Record<string, unknown>).dir
  if (!dir || typeof dir !== 'object') return []
  const pl = (dir as Record<string, unknown>).playlists
  return Array.isArray(pl) ? pl : []
}

export type FolderLinkReport = { ok: boolean; linked: { folder: string; playlists: unknown[] }[] }

// Station 14's folder links on Events, Events/Uploads and each owner folder.
// Legacy links elsewhere (75 → EFM Stingers, 78 → Events/renfair) do not
// cover Events/Uploads and are not reported.
export async function folderLinkCheck(client: EventsAzuraCastClient): Promise<FolderLinkReport> {
  const linked: FolderLinkReport['linked'] = []
  const root = await client.listDirectory('')
  const events = root.find((e) => e.path === 'Events' && e.type === 'directory')
  if (dirLinks(events).length > 0) linked.push({ folder: 'Events', playlists: dirLinks(events) })
  if (events) {
    const inEvents = await client.listDirectory('Events')
    const uploads = inEvents.find((e) => e.path === EVENTS_UPLOAD_DIR && e.type === 'directory')
    if (dirLinks(uploads).length > 0) linked.push({ folder: EVENTS_UPLOAD_DIR, playlists: dirLinks(uploads) })
    if (uploads) {
      for (const owner of await client.listDirectory(EVENTS_UPLOAD_DIR)) {
        if (owner.type === 'directory' && dirLinks(owner).length > 0) linked.push({ folder: owner.path, playlists: dirLinks(owner) })
      }
    }
  }
  return { ok: linked.length === 0, linked }
}
