// Restoring a draft's device copies (0.5.3). A copy holds changes a tab had
// not saved yet, made against `base` (the server copy of that moment). On a
// later load it is merged three-way into the server copy of now, never
// written over it. Two things make that safe when the server moved on:
//   - save records: a copy notes every save it sent whose answer had not
//     come back (a keepalive as the page was hidden or left, a PATCH/PUT in
//     flight when the page was killed). When the event lists a saveId among its
//     recentSaveIds the save arrived, so the copy is rebased onto what it sent
//     and only changes made after it count (usually none: the copy is dropped
//     silently). Without this, a copy whose keepalive arrived would re-apply
//     its old changes over newer work from another device.
//   - the question: when the server is newer than the (rebased) base and the
//     merge would overwrite work done elsewhere (merge.ts restoreConflicts),
//     or when the copy is older than OLD_COPY_MS (the member may no longer
//     want changes from yesterday), nothing is saved until the member chooses.
// The live form applies the same two rules when a newer server copy comes
// in while it is open (autosave.ts sortSaves, rebaseForm below): a hidden tab
// whose keepalive arrived never re-applies it over newer work either.

import { type Backup, type SentSave, sortSaves } from './autosave'
import { builderFromView, draftFromView } from './fromView'
import { describeChanges, type FormState, mergeForm, restoreConflicts } from './merge'
import type { Builder } from './playlist'
import { toInputs } from './RequestParts'
import type { AudioItem, FullView, Stinger } from './types'
import { type Draft, EMPTY_DRAFT } from './wizard'

/** The form as a device copy stores it (startsAt re-splits the date/time in the viewer's zone). */
export type FormData = { draft: Draft; builder: Builder; startsAt: string | null; key: string }

export const EMPTY_BUILDER: Builder = { tracks: [], anns: [], order: 'shuffle' }

/** A backup's form, with the date/time inputs re-split in the viewer's zone. */
export function backupForm(data: FormData, zone: string | undefined): FormState {
  const d = data.startsAt ? { ...data.draft, ...toInputs(data.startsAt, zone) } : data.draft
  return { draft: { ...EMPTY_DRAFT, ...d }, builder: { ...EMPTY_BUILDER, ...data.builder } }
}

export type FormCtx = { zone: string | undefined; audio: AudioItem[]; stingers: Stinger[] }

export const formOfView = (v: FullView, c: FormCtx): FormState => ({ draft: draftFromView(v, c.zone), builder: builderFromView(v, c.audio, c.stingers) })

/** A device copy saved longer ago than this is never restored without asking. */
export const OLD_COPY_MS = 12 * 60 * 60 * 1000

export type RestorePlan = {
  /** The server's form with every copy merged in. */
  form: FormState
  /** The copies hold changes the server does not have. */
  changed: boolean
  /** Ask first (`conflict`, or a copy older than OLD_COPY_MS: `oldAt`). */
  ask: boolean
  /** Restoring would overwrite newer work done elsewhere. */
  conflict: boolean
  /** When the oldest copy past OLD_COPY_MS that holds changes was saved (ms), else null. */
  oldAt: number | null
  /** Fields both sides changed (the copy's value is in `form`). */
  kept: string[]
  /** What restoring changes on the server, in plain words. */
  changes: string[]
  /** The copies read (to clear once saved or discarded). */
  keys: string[]
}

/**
 * The base with saves that arrived applied, oldest first: each part a save
 * carried (details, playlist) becomes what it sent. Used by planRestore and
 * by the live form's merge (RequestForm adopt), so both rebase the same way.
 */
export function rebaseForm(base: FormState, landed: readonly SentSave<FormData>[], zone: string | undefined): FormState {
  let out = base
  for (const k of landed) {
    const sent = backupForm(k.sent, zone)
    out = { draft: k.details ? sent.draft : out.draft, builder: k.playlist ? sent.builder : out.builder }
  }
  return out
}

export function planRestore(server: FullView, copies: readonly { key: string; backup: Backup<FormData> }[], c: FormCtx, now = Date.now()): RestorePlan {
  const serverForm = formOfView(server, c)
  let cur = serverForm
  let changed = false
  let conflict = false
  let oldAt: number | null = null
  const kept: string[] = []
  const keys: string[] = []
  for (const { key, backup } of copies) {
    keys.push(key)
    if (!backup.base) continue
    // Keepalives that arrived: only what changed after them counts. One that
    // arrived on a base this copy does not describe, or may have scrolled
    // out of the list, is unknown: the question decides.
    const fates = sortSaves(backup.keepalive ?? [], backup.baseVersion ?? backup.base.version, server)
    const base = rebaseForm(formOfView(backup.base, c), fates.landed, c.zone)
    const version = fates.version
    const unconfirmed = fates.unknown.length > 0
    const local = backupForm(backup.data, c.zone)
    const r = mergeForm(base, local, cur)
    if (r.local) {
      changed = true
      if (server.version > version && restoreConflicts(base, local, cur, unconfirmed)) conflict = true
      if (now - backup.savedAt > OLD_COPY_MS && (oldAt === null || backup.savedAt < oldAt)) oldAt = backup.savedAt
      for (const k of r.kept) if (!kept.includes(k)) kept.push(k)
    }
    cur = { draft: r.draft, builder: r.builder }
  }
  return { form: cur, changed, ask: conflict || oldAt !== null, conflict, oldAt, kept, changes: changed ? describeChanges(serverForm, cur) : [], keys }
}
