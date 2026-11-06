// v0.2.1 song metadata characters (review SEC-3): one rule for member /
// reviewer edits (reject) and the probe's pre-filled tags (clean), so an
// approved item always finalizes and no bidi / zero-width character reaches
// the on-air tags.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import NodeID3 from 'node-id3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runFinalize } from '@/probe/finalize'
import { runProbe } from '@/probe/probe'
import { clipTag, META_DISALLOWED_RE } from '@/probe/tags'
import type { Viewer } from '@/server/authz/predicates'
import { closeDb } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'
import { metaText } from '@/server/requests/common'
import { finalizeRequest } from '@/server/spool/protocol'
import { editItemMetadata } from '@/server/submissions'
import { Defer } from '@/worker/handlers'
import { runIngest } from '@/worker/ingest/pipeline'
import { ownerSql } from './helpers/db'
import { DBENV, MOCKS } from './helpers/env'
import { fx } from './helpers/fixtures'
import { frameV4, tag } from './helpers/id3'
import { item, makeCtx, mkArtist, mkBatch, mkItem, mkUser, run, slot, uniq } from './helpers/p3'

// Built from code points so no invisible character sits in this source file.
const C = (...cps: number[]) => String.fromCodePoint(...cps)
const RLO = C(0x202e) // right-to-left override (Cf)
const ZWSP = C(0x200b) // zero-width space (Cf)
const BOM = C(0xfeff) // (Cf)
const LS = C(0x2028)
const PS = C(0x2029)
const BEL = C(0x07)
const ACUTE = C(0x0301) // combining acute: e + ACUTE → é under NFC

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    if (e instanceof HttpError) return `${e.status} ${e.code}`
    throw e
  }
}

describe('clipTag (probe pre-fill)', () => {
  it('breaks become one space, format characters vanish, NFC, trimmed, never half a surrogate pair', () => {
    expect(clipTag(`Foo\r\nBar\tBaz${LS}Qux${PS}End`)).toBe('Foo Bar Baz Qux End')
    expect(clipTag(`${BOM}Tr${ZWSP}ack${RLO}kcarT${BEL} `)).toBe('TrackkcarT')
    expect(clipTag(`Caf${'e'}${ZWSP}${ACUTE}`)).toBe('Café')
    expect(clipTag(`${RLO}${ZWSP}\n\t`)).toBeNull()
    expect(clipTag(42)).toBeNull()
    const emoji = C(0x1f3b5)
    const long = clipTag('a'.repeat(199) + emoji)!
    expect(long).toBe('a'.repeat(199))
    expect(clipTag('b'.repeat(250))).toHaveLength(200)
    for (const s of [long, clipTag(`x${RLO}y${LS}z`)!]) {
      expect(META_DISALLOWED_RE.test(s)).toBe(false)
      expect(metaText(200).safeParse(s)).toMatchObject({ success: true, data: s })
    }
  })
})

describe('metaText (edits: the edit-request rule, reused by the item PATCH)', () => {
  it('rejects controls incl. \\n and \\t, \\p{Cf}, U+2028/2029; normalizes to NFC; length counted after NFC', () => {
    const m = metaText(200)
    for (const bad of ['Foo\nBar', 'A\tB', `x${BEL}`, `${RLO}evil`, `a${ZWSP}b`, `x${BOM}y`, `a${LS}b`, `a${PS}b`, 'a'.repeat(201)]) {
      expect(m.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(m.parse(`  Caf${'e'}${ACUTE}  `)).toBe('Café')
    expect(m.parse(`${BOM}x`)).toBe('x') // a leading / trailing U+FEFF is trimmed away (String.prototype.trim)
    // U+0958 has no NFC composition: it expands to two code points, so a
    // 200-char input can exceed 200 once normalized.
    expect(m.safeParse(C(0x958).repeat(101)).success).toBe(false)
  })
})

// A hostile ID3v2.4 tag (UTF-8 text frames) on a real 35 s / 128 kbps mp3.
function hostileMp3(title: string, artist: string): Buffer {
  const text = (id: string, s: string) => frameV4(id, Buffer.concat([Buffer.from([0x03]), Buffer.from(s, 'utf8')]))
  return Buffer.concat([
    tag(4, [text('TIT2', title), text('TPE1', artist), text('TALB', `Al${RLO}bum\nTwo`), text('TCON', `Po${ZWSP}p`)]),
    readFileSync(fx('raw35.mp3')),
  ])
}

describe.skipIf(!DBENV() || !MOCKS())('edits and pre-filled tags always finalize (SEC-3)', () => {
  const viewer = (u: { id: string; discordId: string }): Viewer => ({ userId: u.id, discordId: u.discordId, name: null, perms: new Set(['submit', 'request']) as Viewer['perms'] })
  let root: string
  let dirs: { uploads: string; work: string; final: string; mmChild: string }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'meta-text-'))
    dirs = { uploads: join(root, 'uploads'), work: join(root, 'work'), final: join(root, 'final'), mmChild: resolve('dist/probe/mm-child.mjs') }
    for (const d of [dirs.uploads, dirs.work, dirs.final]) mkdirSync(d)
  })
  afterAll(async () => closeDb())

  it('PATCH /api/items/:id refuses newline, tab, bidi, zero-width and separators; NFC-normalizes', async () => {
    const ctx = makeCtx(slot(700))
    const owner = await mkUser()
    const b = await mkBatch(owner.id, { status: 'draft' })
    const s = await mkItem({ batchId: b, ownerId: owner.id, status: 'pending', title: 'Orig', artist: 'Someone' })
    const v = viewer(owner)
    for (const bad of [{ title: 'Foo\nBar' }, { artist: 'A\tB' }, { title: `${RLO}evil` }, { album: `a${ZWSP}b` }, { genre: `x${LS}y` }, { title: `x${PS}y` }]) {
      expect(await code(editItemMetadata(ctx.db, v, s, bad)), JSON.stringify(bad)).toBe('400 invalid_edit')
    }
    expect(await editItemMetadata(ctx.db, v, s, { title: ` Caf${'e'}${ACUTE} ` })).toMatchObject({ title: 'Café' })
    ctx.cleanup()
  })

  it('an approved item with pre-filled hostile tags stages finalize and the probe finalizes it', async () => {
    const t = uniq()
    const folder = `PT Meta ${t}`
    const mp3 = hostileMp3(`Line${RLO} One\nTwo\tThree${LS}Four${ZWSP}${BOM}`, `${folder}${ZWSP}${RLO}`)
    const sha = createHash('sha256').update(mp3).digest('hex')

    // 1. the probe (bundled mm-child) pre-fills clean tags
    const upload = randomUUID().replace(/-/g, '')
    writeFileSync(join(dirs.uploads, upload), mp3)
    const p = await runProbe({ v: 1, id: randomUUID(), type: 'probe', upload, expectedSize: mp3.length }, dirs)
    if (!p.ok || p.type !== 'probe') throw new Error(JSON.stringify(p))
    expect(p.tags).toMatchObject({ title: 'Line One Two Three Four', artist: folder, album: 'Album Two', genre: 'Pop' })
    for (const v of Object.values(p.tags)) if (typeof v === 'string') expect(META_DISALLOWED_RE.test(v)).toBe(false)

    // 2. approved as pre-filled (nobody edited it): the worker stages finalize
    const ctx = makeCtx(slot(701))
    const owner = await mkUser()
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const id = await mkItem({ batchId: b, ownerId: owner.id, title: p.tags.title, artist: p.tags.artist, artistId, probeSha: sha })
    await ownerSql()`UPDATE items SET album = ${p.tags.album}, genre = ${p.tags.genre} WHERE id = ${id}`
    let staged: Defer | null = null
    try {
      await runIngest(ctx, { itemId: id })
    } catch (e) {
      if (!(e instanceof Defer)) throw e
      staged = e
    }
    expect(staged?.message).toBe('finalize submitted')
    expect((await item(id)).status).toBe('applying')

    // 3. the probe finalizes that request (clean ID3 written)
    const r = await run(id)
    const req = finalizeRequest.parse(JSON.parse(readFileSync(join(ctx.spoolInDir, `${r!.finalize_request_id}.json`), 'utf8')))
    copyFileSync(join(dirs.uploads, upload), join(dirs.uploads, (await item(id)).upload_id as string))
    const f = await runFinalize(req, { uploads: dirs.uploads, work: dirs.work, final: dirs.final })
    if (!f.ok || f.type !== 'finalize') throw new Error(JSON.stringify(f))
    const tags = NodeID3.read(join(dirs.final, f.file))
    expect(tags).toMatchObject({ title: 'Line One Two Three Four', artist: folder })
    ctx.cleanup()
  })
})
