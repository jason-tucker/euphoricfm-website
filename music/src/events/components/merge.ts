// Three-way merge of the request form (0.5.3). Two tabs (or a device backup
// and the server) may change the same draft. Each side's changes are taken
// against the `base` both started from (the server copy the form last
// loaded or saved):
//   - a detail field this side did not change takes the server's value; a
//     field it changed keeps its value (when the server changed it too, to
//     something else, this side wins and the field is named in `kept`);
//   - songs are a set by song (source + id): the result is the server's
//     songs minus the ones this side removed plus the ones it added (a song
//     the server already has is not added twice; a pin this side changed is
//     applied to it);
//   - announcements are a multiset by their whole content; this side's
//     removals take that many copies away, its additions make sure the result
//     holds at least as many copies as this side has (so applying the same
//     changes twice, e.g. a backup whose keepalive already arrived, adds
//     nothing);
//   - the playlist order is this side's when it changed it, else the server's.
// All inputs are form-level (Draft + Builder) so a backup can be merged into
// a form that already holds other merged changes.

import type { BAnn, BTrack, Builder } from './playlist'
import { trackId } from './playlist'
import type { Draft } from './wizard'

export type FormState = { draft: Draft; builder: Builder }

export type MergeResult = FormState & {
  /** The server side had changes this side did not (they are now in the form). */
  merged: boolean
  /** Fields both sides changed to different values; this side's value was kept. */
  kept: string[]
  /** This side has changes the server does not have yet. */
  local: boolean
}

const FIELDS = [
  ['title', 'title'],
  ['hostName', 'host name'],
  ['description', 'description'],
  ['location', 'place'],
  ['eventType', 'kind of event'],
  ['visibility', 'visibility'],
] as const satisfies readonly (readonly [keyof Draft, string])[]

const norm = (s: string) => s.trim()
const whenKey = (d: Draft) => `${d.date}|${d.time}|${d.lengthMin}`

const ms = (s: string | null) => (s ? Date.parse(s) : null)
export const annKey = (a: Pick<BAnn, 'source' | 'mediaId' | 'audioId' | 'mode' | 'at' | 'everyMin' | 'from' | 'until'>) =>
  JSON.stringify([
    a.source,
    a.source === 'stinger' ? a.mediaId : a.audioId,
    a.mode,
    a.mode === 'at' ? ms(a.at) : null,
    a.mode === 'every' ? a.everyMin : null,
    a.mode === 'every' ? ms(a.from) : null,
    a.mode === 'every' ? ms(a.until) : null,
  ])

/** Content key of a builder (song order matters; announcement order does not). */
export function builderKey(b: Builder): string {
  return JSON.stringify({ o: b.order, t: b.tracks.map((t) => [trackId(t), ms(t.pinAt)]), a: b.anns.map(annKey).sort() })
}

function mergeDraft(base: Draft, local: Draft, server: Draft, kept: string[]): { draft: Draft; theirs: boolean; mine: boolean } {
  const out: Draft = { ...local }
  let theirs = false
  let mine = false
  for (const [f, label] of FIELDS) {
    const b = norm(base[f] as string)
    const l = norm(local[f] as string)
    const s = norm(server[f] as string)
    if (l === b) {
      ;(out as Record<string, unknown>)[f] = server[f]
      if (s !== b) theirs = true
    } else {
      if (l !== s) mine = true
      if (s !== b && s !== l) {
        theirs = true
        kept.push(label)
      }
    }
  }
  const [b, l, s] = [whenKey(base), whenKey(local), whenKey(server)]
  if (l === b) {
    out.date = server.date
    out.time = server.time
    out.lengthMin = server.lengthMin
    if (s !== b) theirs = true
  } else {
    if (l !== s) mine = true
    if (s !== b && s !== l) {
      theirs = true
      kept.push('date and time')
    }
  }
  return { draft: out, theirs, mine }
}

function mergeTracks(base: BTrack[], local: BTrack[], server: BTrack[]): BTrack[] {
  const inBase = new Map(base.map((t) => [trackId(t), t]))
  const inLocal = new Map(local.map((t) => [trackId(t), t]))
  // the server's songs minus the ones this side removed (reusing this side's
  // rows where it has the same song, so the list keeps its keys)
  let out = server.filter((t) => !(inBase.has(trackId(t)) && !inLocal.has(trackId(t)))).map((t) => {
    const l = inLocal.get(trackId(t))
    return l ? { ...l, pinAt: t.pinAt } : t
  })
  for (const l of local) {
    const id = trackId(l)
    const b = inBase.get(id)
    const i = out.findIndex((t) => trackId(t) === id)
    const pinChanged = !b || ms(b.pinAt) !== ms(l.pinAt)
    if (i >= 0) {
      if (pinChanged) out = out.map((t, k) => (k === i ? { ...t, pinAt: l.pinAt } : t))
    } else if (!b) {
      out = [...out, l] // added here
    }
    // in base, not on the server: removed there; stays removed
  }
  return out
}

function mergeAnns(base: BAnn[], local: BAnn[], server: BAnn[]): BAnn[] {
  const count = (l: BAnn[]) => {
    const m = new Map<string, number>()
    for (const a of l) m.set(annKey(a), (m.get(annKey(a)) ?? 0) + 1)
    return m
  }
  const cb = count(base)
  const cl = count(local)
  let out = [...server]
  for (const [k, n] of cb) {
    let drop = n - (cl.get(k) ?? 0)
    if (drop <= 0) continue
    out = out.filter((a) => (drop > 0 && annKey(a) === k ? (drop--, false) : true))
  }
  for (const a of local) {
    const k = annKey(a)
    if ((cl.get(k) ?? 0) <= (cb.get(k) ?? 0)) continue
    if (out.filter((x) => annKey(x) === k).length < cl.get(k)!) out = [...out, a]
  }
  return out
}

function mergeBuilder(base: Builder, local: Builder, server: Builder): { builder: Builder; theirs: boolean; mine: boolean } {
  const [b, l, s] = [builderKey(base), builderKey(local), builderKey(server)]
  if (l === b) return { builder: server, theirs: s !== b, mine: false }
  if (s === b || s === l) return { builder: local, theirs: false, mine: l !== s }
  const builder: Builder = {
    tracks: mergeTracks(base.tracks, local.tracks, server.tracks),
    anns: mergeAnns(base.anns, local.anns, server.anns),
    order: local.order !== base.order ? local.order : server.order,
  }
  return { builder, theirs: true, mine: builderKey(builder) !== s }
}

/**
 * Merge `local` (this side's form, relative to `base`) with `server`. The
 * result is what the form should show; saving it sends only this side's
 * changes (every other field equals the server's).
 */
export function mergeForm(base: FormState, local: FormState, server: FormState): MergeResult {
  const kept: string[] = []
  const d = mergeDraft(base.draft, local.draft, server.draft, kept)
  const p = mergeBuilder(base.builder, local.builder, server.builder)
  return { draft: d.draft, builder: p.builder, merged: d.theirs || p.theirs, kept, local: d.mine || p.mine }
}

/** "title", "title and host name", "title, place and host name". */
export const listWords = (w: string[]) => (w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w.at(-1)}` : (w[0] ?? ''))

const clip = (v: string) => {
  const t = v.trim().replace(/\s+/g, ' ')
  return t.length > 40 ? `${t.slice(0, 39)}…` : t
}

function countBy<T>(list: readonly T[], key: (x: T) => string): Map<string, { n: number; first: T }> {
  const m = new Map<string, { n: number; first: T }>()
  for (const x of list) {
    const k = key(x)
    const c = m.get(k)
    if (c) c.n++
    else m.set(k, { n: 1, first: x })
  }
  return m
}

/**
 * What changes from `from` to `to`, in plain words: `host name → "PC host"`,
 * `place cleared`, `removed "Charlie"`, `added announcement "Welcome"`, …
 * (the merge and restore notes, and the restore question).
 */
export function describeChanges(from: FormState, to: FormState): string[] {
  const out: string[] = []
  for (const [f, label] of FIELDS) {
    const a = norm(from.draft[f] as string)
    const b = norm(to.draft[f] as string)
    if (a !== b) out.push(b ? `${label} → "${clip(b)}"` : `${label} cleared`)
  }
  if (whenKey(from.draft) !== whenKey(to.draft)) out.push(to.draft.date && to.draft.time ? `date and time → ${to.draft.date} ${to.draft.time}, ${to.draft.lengthMin} min` : 'date and time changed')
  const ft = new Map(from.builder.tracks.map((t) => [trackId(t), t]))
  const tt = new Map(to.builder.tracks.map((t) => [trackId(t), t]))
  for (const [id, t] of ft) if (!tt.has(id)) out.push(`removed "${clip(t.title)}"`)
  for (const [id, t] of tt) {
    const f = ft.get(id)
    if (!f) out.push(`added "${clip(t.title)}"`)
    else if (ms(f.pinAt) !== ms(t.pinAt)) out.push(`pin of "${clip(t.title)}" changed`)
  }
  const common = (l: BTrack[], other: Map<string, BTrack>) => l.map(trackId).filter((id) => other.has(id))
  if (common(from.builder.tracks, tt).join('|') !== common(to.builder.tracks, ft).join('|')) out.push('song order changed')
  if (from.builder.order !== to.builder.order) out.push(`play order → ${to.builder.order === 'shuffle' ? 'shuffle' : 'in your order'}`)
  const fa = countBy(from.builder.anns, annKey)
  const ta = countBy(to.builder.anns, annKey)
  for (const [k, c] of fa) for (let i = ta.get(k)?.n ?? 0; i < c.n; i++) out.push(`removed announcement "${clip(c.first.title)}"`)
  for (const [k, c] of ta) for (let i = fa.get(k)?.n ?? 0; i < c.n; i++) out.push(`added announcement "${clip(c.first.title)}"`)
  return out
}

/**
 * Would restoring `local` (a device copy made against `base`) onto `server`
 * (NEWER than base) undo work done elsewhere? True when the merge would
 * overwrite a field (or a pin, or the play order) the server also changed,
 * remove a song or announcement the server has, or — when the copy sent a
 * save that is not known to have arrived (`unconfirmed`) — add back one the
 * server does not have, or set a field, pin, song order or play order the
 * server holds at the base value (it may have been sent, then undone
 * elsewhere).
 * Such a restore waits for the member's choice instead of saving itself.
 */
export function restoreConflicts(base: FormState, local: FormState, server: FormState, unconfirmed: boolean): boolean {
  if (mergeForm(base, local, server).kept.length) return true
  const [b, l, s] = [base.builder, local.builder, server.builder]
  if (l.order !== b.order && s.order !== b.order && l.order !== s.order) return true
  const ib = new Map(b.tracks.map((t) => [trackId(t), t]))
  const il = new Map(l.tracks.map((t) => [trackId(t), t]))
  const is = new Map(s.tracks.map((t) => [trackId(t), t]))
  for (const [id, t] of ib) {
    const lt = il.get(id)
    const st = is.get(id)
    if (!lt && st) return true // removes a song the server has
    if (lt && st && ms(lt.pinAt) !== ms(t.pinAt) && ms(st.pinAt) !== ms(t.pinAt) && ms(lt.pinAt) !== ms(st.pinAt)) return true
  }
  const cb = countBy(b.anns, annKey)
  const cl = countBy(l.anns, annKey)
  const cs = countBy(s.anns, annKey)
  for (const [k, c] of cb) if ((cl.get(k)?.n ?? 0) < c.n && (cs.get(k)?.n ?? 0) > 0) return true
  if (unconfirmed) {
    const [bd, ld, sd] = [base.draft, local.draft, server.draft]
    for (const [f] of FIELDS) if (norm(ld[f] as string) !== norm(bd[f] as string) && norm(sd[f] as string) === norm(bd[f] as string)) return true
    if (whenKey(ld) !== whenKey(bd) && whenKey(sd) === whenKey(bd)) return true
    if (l.order !== b.order && s.order === b.order) return true
    for (const [id, lt] of il) {
      const bt = ib.get(id)
      const st = is.get(id)
      if (bt && st && ms(lt.pinAt) !== ms(bt.pinAt) && ms(st.pinAt) === ms(bt.pinAt)) return true
    }
    // the relative order of the songs all three hold
    const seq = (x: BTrack[]) => x.map(trackId).filter((id) => ib.has(id) && il.has(id) && is.has(id)).join('|')
    if (seq(l.tracks) !== seq(b.tracks) && seq(s.tracks) === seq(b.tracks)) return true
    for (const [id] of il) if (!ib.has(id) && !is.has(id)) return true
    for (const [k, c] of cl) if (c.n > (cb.get(k)?.n ?? 0) && (cs.get(k)?.n ?? 0) < c.n) return true
  }
  return false
}

/**
 * The note after another tab's (or device's) work was merged into this form: what came in
 * (`incoming`, from describeChanges(form before, form after)) and the fields
 * where this tab's value was kept. Null when nothing visible came in (e.g.
 * this tab's own keepalive save arriving).
 */
export function mergeNote(incoming: string[], kept: string[]): string | null {
  if (!incoming.length && !kept.length) return null
  const what = incoming.length ? `Merged changes made in another tab or device: ${listWords(incoming)}.` : 'Merged changes made in another tab or device.'
  return `${what}${kept.length ? ` Kept this tab's ${listWords(kept)}.` : ''}`
}
