// Restoring a draft's device copies (0.5.3). A copy holds changes a tab had
// not saved yet, made against `base` (the server copy of that moment). On a
// later load it is merged three-way into the server copy of now, never
// written over it. Two things make that safe when the server moved on:
//   - keepalive records: a copy notes the saves it sent as the page was
//     hidden or left (their saveIds). When the event lists a saveId among its
//     recentSaveIds the save arrived, so the copy is rebased onto what it sent
//     and only changes made after it count (usually none: the copy is dropped
//     silently). Without this, a copy whose keepalive arrived would re-apply
//     its old changes over newer work from another device.
//   - the question: when the server is newer than the (rebased) base and the
//     merge would overwrite work done elsewhere (merge.ts restoreConflicts),
//     nothing is saved until the member chooses.

import { RECENT_SAVE_IDS } from '@/events/contract/rules'
import type { Backup } from './autosave'
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

export type RestorePlan = {
  /** The server's form with every copy merged in. */
  form: FormState
  /** The copies hold changes the server does not have. */
  changed: boolean
  /** Restoring would overwrite newer work done elsewhere: ask first. */
  ask: boolean
  /** Fields both sides changed (the copy's value is in `form`). */
  kept: string[]
  /** What restoring changes on the server, in plain words. */
  changes: string[]
  /** The copies read (to clear once saved or discarded). */
  keys: string[]
}

export function planRestore(server: FullView, copies: readonly { key: string; backup: Backup<FormData> }[], c: FormCtx): RestorePlan {
  const serverForm = formOfView(server, c)
  const recent = new Set(server.recentSaveIds ?? [])
  // A saveId missing from a list that is not full was never recorded: that
  // keepalive did not arrive. From a full list (or none) it may have
  // scrolled out: unknown.
  const listComplete = !!server.recentSaveIds && server.recentSaveIds.length < RECENT_SAVE_IDS
  let cur = serverForm
  let changed = false
  let ask = false
  const kept: string[] = []
  const keys: string[] = []
  for (const { key, backup } of copies) {
    keys.push(key)
    if (!backup.base) continue
    let base = formOfView(backup.base, c)
    let version = backup.baseVersion ?? backup.base.version
    let unconfirmed = false
    for (const k of backup.keepalive ?? []) {
      const sent = backupForm(k.sent, c.zone)
      if (k.patch) {
        if (recent.has(k.patch)) {
          base = { ...base, draft: sent.draft }
          version++
        } else if (!listComplete) unconfirmed = true
      }
      if (k.playlist) {
        if (recent.has(k.playlist)) {
          base = { ...base, builder: sent.builder }
          version++
        } else if (!listComplete) unconfirmed = true
      }
    }
    const local = backupForm(backup.data, c.zone)
    const r = mergeForm(base, local, cur)
    if (r.local) {
      changed = true
      if (server.version > version && restoreConflicts(base, local, cur, unconfirmed)) ask = true
      for (const k of r.kept) if (!kept.includes(k)) kept.push(k)
    }
    cur = { draft: r.draft, builder: r.builder }
  }
  return { form: cur, changed, ask, kept, changes: changed ? describeChanges(serverForm, cur) : [], keys }
}
