// A saved event → the form's state: the details/time inputs (split in the
// viewer's zone) and the playlist builder.

import type { EventTrack } from '@/events/contract/types'
import { newKey, recallTitle } from './PlaylistBuilder'
import type { BAnn, BTrack, Builder } from './playlist'
import { toInputs } from './RequestParts'
import { MIN } from './time'
import type { AudioItem, FullView, Stinger } from './types'
import type { Draft } from './wizard'

/**
 * Rebuild the playlist builder from a saved event. The server resolves a
 * display `label` (title, artist, length) on every track and announcement, so
 * staff and fresh sessions see real names; the viewer's own audio list, the
 * stinger list and this browser's library-search memory are only fallbacks.
 */
export function builderFromView(v: FullView, audio: AudioItem[], stingers: Stinger[]): Builder {
  const tracks: BTrack[] = [...v.tracks]
    .sort((a: EventTrack, b: EventTrack) => a.position - b.position)
    .map((t) => {
      const l = t.label
      if (t.source === 'upload') {
        const a = l ? null : audio.find((x) => x.id === t.audioId)
        return { key: newKey(), source: 'upload', mediaId: null, audioId: t.audioId, title: l?.title ?? a?.title ?? `Upload #${t.audioId}`, artist: l ? l.artist : (a?.artist ?? null), lengthS: l ? l.lengthS : (a?.durationS ?? null), pinAt: t.pinAt }
      }
      const r = !l && t.mediaId ? recallTitle(t.mediaId) : null
      return { key: newKey(), source: 'library', mediaId: t.mediaId, audioId: null, title: l?.title ?? r?.title ?? `Library song #${t.mediaId}`, artist: l ? l.artist : (r?.artist ?? null), lengthS: l ? l.lengthS : (r?.lengthS ?? null), pinAt: t.pinAt }
    })
  const anns: BAnn[] = v.announcements.map((a) => {
    const l = a.label
    const st = !l && a.source === 'stinger' ? stingers.find((s) => s.mediaId === a.mediaId) : null
    const up = !l && a.source === 'upload' ? audio.find((x) => x.id === a.audioId) : null
    return {
      key: newKey(),
      source: a.source,
      mediaId: a.mediaId,
      audioId: a.audioId,
      title: l?.title ?? st?.title ?? up?.title ?? (a.source === 'stinger' ? `Announcement #${a.mediaId}` : `Upload #${a.audioId}`),
      lengthS: l ? l.lengthS : (st?.lengthS ?? up?.durationS ?? null),
      mode: a.mode,
      at: a.at,
      everyMin: a.everyMin,
      from: a.from,
      until: a.until,
    }
  })
  return { tracks, anns, order: v.playlistOrder }
}

export function draftFromView(v: FullView, zone: string | undefined): Draft {
  const s = toInputs(v.startsAt, zone)
  return {
    title: v.title,
    hostName: v.hostName ?? '',
    description: v.description ?? '',
    location: v.location ?? '',
    eventType: v.eventType,
    date: s.date,
    time: s.time,
    lengthMin: Math.round((Date.parse(v.endsAt) - Date.parse(v.startsAt)) / MIN),
    visibility: v.visibility,
  }
}

/** The PATCH body: only fields that changed. */
export function patchFor(v: FullView, d: Draft, startsAt: string | null, endsAt: string | null, tz: string): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  const nul = (s: string) => (s.trim() ? s.trim() : null)
  if (d.title.trim() !== v.title) p.title = d.title.trim()
  if (nul(d.hostName) !== v.hostName) p.hostName = nul(d.hostName)
  if (nul(d.description) !== v.description) p.description = nul(d.description)
  if (nul(d.location) !== v.location) p.location = nul(d.location)
  if (d.eventType && d.eventType !== v.eventType) p.eventType = d.eventType
  if (d.visibility && d.visibility !== v.visibility) p.visibility = d.visibility
  if (startsAt && endsAt && (Date.parse(startsAt) !== Date.parse(v.startsAt) || Date.parse(endsAt) !== Date.parse(v.endsAt))) {
    p.startsAt = startsAt
    p.endsAt = endsAt
    p.enteredTz = tz
  }
  return p
}

/** Does a patch touch anything that needs re-approval (title, time, visibility)? */
export const patchNeedsReapproval = (p: Record<string, unknown>) => 'title' in p || 'startsAt' in p || 'visibility' in p

