// Artists (plan §3.1, §3.5; P3 "new-artist approval").
//
//  * mainArtist(): the library's rule for which folder a song lives in: the
//    FIRST-listed artist (`X x Y`, `X & Y`, `X, Y`, `X feat. Y` → X).
//  * approveNewArtist(): a `new_artist` item's approval creates the artists
//    row with a folder from the STRICT sanitizer (paths/builder
//    newArtistFolder), or links an existing artist with that name / alias /
//    folder, and links the batch's song items that were waiting on it.
//  * resolveArtistGate(): the worker's gate before a song is finalized: the
//    song needs an ACTIVE artist; a pending new-artist item makes it wait; a
//    denied one fails it.

import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { audit } from '../audit'
import type { Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { artists, items } from '../db/schema'
import { badRequest, conflict } from '../http/errors'
import { enqueue } from '../jobs'
import { artistDirPath, newArtistFolder, PathError } from '../paths/builder'

export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0]
type Q = DB | Tx
type Item = typeof items.$inferSelect
type Artist = typeof artists.$inferSelect

const SPLIT = /\s+(?:feat\.?|ft\.?|featuring)\s+|\s*&\s*|\s*,\s*/i
// ' x ' splits only in lower case ("Malcolm X Band" stays whole).
const SPLIT_X = /\s+x\s+/

export function mainArtist(raw: string | null | undefined): string {
  const s = String(raw ?? '').normalize('NFC').trim()
  return s.split(SPLIT)[0]!.split(SPLIT_X)[0]!.trim()
}

async function findActiveOrPendingByName(db: Q, name: string): Promise<Artist[]> {
  if (!name) return []
  return db
    .select()
    .from(artists)
    .where(
      and(
        sql`${artists.status} IN ('active', 'pending')`,
        sql`(lower(${artists.name}) = lower(${name}) OR lower(${name}) = ANY (SELECT lower(a) FROM unnest(${artists.aliases}) AS a))`,
      ),
    )
    .orderBy(artists.id)
    .limit(3)
}

// A reviewer-chosen folder must already BE what the strict sanitizer
// produces (the UI previews it with the same function), and must pass the
// artist-directory assertions.
export function validateNewFolder(folder: string): string {
  try {
    if (newArtistFolder(folder) !== folder) throw badRequest('folder_not_sanitized')
    artistDirPath('', folder)
  } catch (e) {
    if (e instanceof PathError) throw badRequest('folder_invalid', { reason: e.code })
    throw e
  }
  return folder
}

// Called inside decideItem's transaction after a `new_artist` item won the
// conditional approve UPDATE. Throws 400/409 to roll the approval back.
// An artist that already exists under this name or alias is linked instead
// of creating a second folder (the library's merged-spellings rule).
export async function approveNewArtist(tx: Tx, item: Item, v: Viewer, chosenFolder?: string): Promise<Artist> {
  const name = (item.newArtistName ?? '').normalize('NFC').trim()
  if (!name) throw badRequest('new_artist_name_missing')
  let folder: string
  if (chosenFolder !== undefined) folder = validateNewFolder(chosenFolder)
  else {
    try {
      folder = newArtistFolder(name)
    } catch (e) {
      if (e instanceof PathError) throw badRequest('artist_name_unusable')
      throw e
    }
  }
  let artist: Artist | undefined
  const byName = (await findActiveOrPendingByName(tx, name))[0]
  if (byName) artist = byName
  if (!artist) {
    const byFolder = await tx.query.artists.findFirst({ where: sql`lower(${artists.folder}) = lower(${folder})` })
    if (byFolder) {
      // Same sanitized folder but a different artist ("AC/DC" vs "AC DC"):
      // never merge two artists into one folder silently.
      throw conflict('artist_folder_taken')
    }
  }
  if (artist) {
    if (artist.status !== 'active') {
      ;[artist] = await tx.update(artists).set({ status: 'active', updatedAt: new Date() }).where(eq(artists.id, artist.id)).returning()
    }
  } else {
    ;[artist] = await tx.insert(artists).values({ name, folder, status: 'active' }).returning()
    await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'artist.create', targetType: 'artist', targetId: artist!.id, detail: { name, folder, itemId: item.id } })
  }
  await tx.update(items).set({ artistId: artist!.id, updatedAt: new Date() }).where(eq(items.id, item.id))
  // Songs in the same batch that named this new artist were gated on it.
  await tx
    .update(items)
    .set({ artistId: artist!.id, updatedAt: new Date() })
    .where(and(eq(items.batchId, item.batchId), eq(items.kind, 'song'), isNull(items.artistId), sql`lower(${items.newArtistName}) = lower(${name})`))
  return artist!
}

// decideItem hook (same transaction): what an approval sets in motion.
export async function afterApprove(tx: Tx, row: Item, v: Viewer, opts: { folder?: string } = {}): Promise<void> {
  if (row.kind === 'new_artist') {
    await approveNewArtist(tx, row, v, opts.folder)
    return
  }
  await enqueue(tx, 'ingest', { itemId: row.id }, { dedupeKey: `ingest:item:${row.id}` })
}

export type ArtistGate =
  | { kind: 'ok'; artistId: number; folder: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'fail'; reason: string }

function gateFor(a: Artist): ArtistGate {
  if (a.status === 'active') return { kind: 'ok', artistId: a.id, folder: a.folder }
  if (a.status === 'pending') return { kind: 'wait', reason: 'artist_pending' }
  return { kind: 'fail', reason: `artist_${a.status}` }
}

export async function resolveArtistGate(db: DB, it: Item): Promise<ArtistGate> {
  if (it.artistId) {
    const a = await db.query.artists.findFirst({ where: eq(artists.id, it.artistId) })
    return a ? gateFor(a) : { kind: 'fail', reason: 'artist_missing' }
  }
  if (it.newArtistName) {
    const na = await db.query.items.findFirst({
      where: and(eq(items.batchId, it.batchId), eq(items.kind, 'new_artist'), sql`lower(${items.newArtistName}) = lower(${it.newArtistName})`),
      orderBy: desc(items.id),
    })
    if (na) {
      if (['probing', 'draft', 'pending'].includes(na.status)) return { kind: 'wait', reason: 'new_artist_pending' }
      if (na.status !== 'approved' || !na.artistId) return { kind: 'fail', reason: 'artist_denied' }
      await db.update(items).set({ artistId: na.artistId, updatedAt: new Date() }).where(eq(items.id, it.id))
      const a = await db.query.artists.findFirst({ where: eq(artists.id, na.artistId) })
      return a ? gateFor(a) : { kind: 'fail', reason: 'artist_missing' }
    }
  }
  const matches = await findActiveOrPendingByName(db, mainArtist(it.newArtistName ?? it.artist))
  if (matches.length > 1) return { kind: 'fail', reason: 'artist_ambiguous' }
  const a = matches[0]
  if (!a) return { kind: 'fail', reason: 'artist_unknown' }
  if (a.status === 'active') await db.update(items).set({ artistId: a.id, updatedAt: new Date() }).where(eq(items.id, it.id))
  return gateFor(a)
}

// At submit (and after a reviewer changes a song's artist): every pending
// song whose main artist is not a known artist gets linked to a `new_artist`
// item in the same batch (one per distinct name), with the folder the strict
// sanitizer proposes. Known artists are linked directly.
export async function ensureNewArtistItems(tx: Tx, batchId: number, ownerUserId: string): Promise<void> {
  const songs = await tx.query.items.findMany({
    where: and(eq(items.batchId, batchId), eq(items.kind, 'song'), eq(items.status, 'pending'), isNull(items.artistId)),
  })
  for (const s of songs) {
    const main = mainArtist(s.artist)
    if (!main) continue
    const known = await findActiveOrPendingByName(tx, main)
    if (known.length === 1) {
      await tx.update(items).set({ artistId: known[0]!.id, newArtistName: null, updatedAt: new Date() }).where(eq(items.id, s.id))
      continue
    }
    let folder: string
    try {
      folder = newArtistFolder(main)
    } catch (e) {
      if (e instanceof PathError) throw badRequest('artist_name_unusable', { itemId: s.id })
      throw e
    }
    await tx.update(items).set({ newArtistName: main, updatedAt: new Date() }).where(eq(items.id, s.id))
    const open = await tx.query.items.findFirst({
      where: and(eq(items.batchId, batchId), eq(items.kind, 'new_artist'), sql`${items.status} IN ('pending', 'approved')`, sql`lower(${items.newArtistName}) = lower(${main})`),
    })
    if (!open) {
      await tx.insert(items).values({
        batchId,
        ownerUserId,
        kind: 'new_artist',
        source: 'upload',
        status: 'pending',
        newArtistName: main,
        artist: main,
        prefill: { proposedFolder: folder },
      })
    }
  }
}
