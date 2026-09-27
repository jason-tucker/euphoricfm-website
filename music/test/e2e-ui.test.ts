// Render smoke of every portal page against the built music-web container
// (mock Discord / tickets / AzuraCast, real Postgres, real probe): pages
// render for the right viewers, 404/redirect for the wrong ones, carry no
// inline style attributes, nonce every script, and staff comments stay out
// of the member's HTML.
import { describe, expect, it } from 'vitest'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { has } from './helpers/env'
import { fxBuf } from './helpers/fixtures'
import { Jar, req } from './helpers/http'
import { tusUpload } from './helpers/tus'

const E2E_UI = () => has('E2E_WEB_URL', 'MOCKS_CONTROL', 'TEST_OWNER_DATABASE_URL')
const OWNER = '117501528641634310' // PORTAL_OWNER_IDS in test/compose.test.yml → admin
let seq = 0
const newId = () => `6${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`

async function page(jar: Jar | null, path: string) {
  const r = await req(jar, path)
  // React separates adjacent text nodes with <!-- --> markers; drop them.
  const html = r.status === 200 || r.status === 404 ? (await r.text()).replace(/<!-- -->/g, '') : ''
  if (html) {
    // CSP style-src 'self': no inline style attributes; script-src nonce only.
    expect(html, `${path} has an inline style attribute`).not.toMatch(/<[a-z][^>]*\sstyle="/i)
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(r.headers.get('content-security-policy') ?? '')?.[1]
    for (const s of html.matchAll(/<script\b[^>]*>/g)) expect(s[0], `${path} script without nonce`).toContain(`nonce="${nonce}"`)
  }
  return { status: r.status, html, location: r.headers.get('location') ?? '' }
}

async function waitPending(jar: Jar, itemId: number) {
  const deadline = Date.now() + 60_000
  for (;;) {
    const it = (await (await req(jar, `/api/items/${itemId}`)).json()) as { status: string; title: string | null }
    if (it.status !== 'probing') return it
    if (Date.now() > deadline) throw new Error('probe timeout')
    await new Promise((r) => setTimeout(r, 500))
  }
}

describe.skipIf(!E2E_UI())('portal pages render (built server, mocked externals)', () => {
  it('signed out: landing and denied render; member pages redirect', async () => {
    const home = await page(null, '/')
    expect(home.status).toBe(200)
    expect(home.html).toContain('Sign in with Discord')
    const denied = await page(null, '/denied?reason=not_member')
    expect(denied.status).toBe(200)
    expect(denied.html).toContain('not in the EuphoricFM Discord server')
    const pending = await page(null, '/denied?reason=pending')
    expect(pending.html).toContain('membership is still pending')
    for (const p of ['/dashboard', '/submit', '/review', '/admin', '/batches/1']) {
      const r = await page(null, p)
      expect([302, 303, 307], p).toContain(r.status)
    }
  })

  it('member flow: dashboard, submit, batch detail; staff notes hidden; no review/admin', async () => {
    const member = await loginOk({ id: newId() })
    const admin = await loginOk({ id: OWNER })

    const dash = await page(member, '/dashboard')
    expect(dash.status).toBe(200)
    expect(dash.html).toContain('My music')
    expect(dash.html).toContain('Submit your first songs')

    const submit = await page(member, '/submit')
    expect(submit.status).toBe(200)
    expect(submit.html).toContain('Drop MP3 files here')
    expect(submit.html).toContain('Coming soon')
    expect(submit.html).toContain('Rights statement version')

    // Create a batch with one probed file, as the client does.
    const b = (await (await req(member, '/api/batches', { method: 'POST' })).json()) as { id: number }
    const uploadId = await tusUpload(member, fxBuf('tagged-png.mp3'))
    const add = await req(member, `/api/batches/${b.id}/items`, { json: { uploadId } })
    expect(add.status).toBe(201)
    const item = (await add.json()) as { id: number }
    const probed = await waitPending(member, item.id)
    expect(probed.status).toBe('pending')

    const draft = await page(member, `/submit?batch=${b.id}`)
    expect(draft.status).toBe(200)
    expect(draft.html).toContain(`Draft batch #${b.id}`)

    const lib = await req(member, '/api/ui/library?field=artist&q=te')
    expect(lib.status).toBe(200)
    const who = (await (await req(member, `/api/ui/artist?name=${encodeURIComponent('Test Artist')}`)).json()) as { known: unknown; proposedFolder: string }
    expect(who.known).toBeNull()
    expect(who.proposedFolder).toBe('Test Artist')
    expect((await req(member, '/api/ui/artist?folder=x')).status).toBe(403)

    // Submitting without the attestation is refused by the server too.
    expect((await req(member, `/api/batches/${b.id}/submit`, { json: {} })).status).toBe(400)
    expect((await req(member, `/api/batches/${b.id}/submit`, { json: { attest: true, attestVersion: 'x' } })).status).toBe(200)

    expect((await req(member, `/api/batches/${b.id}/comments`, { json: { body: 'member public note' } })).status).toBe(201)
    expect((await req(admin, `/api/batches/${b.id}/comments`, { json: { body: 'TOP SECRET staff note', visibility: 'staff', itemId: item.id } })).status).toBe(201)

    const detail = await page(member, `/batches/${b.id}`)
    expect(detail.status).toBe(200)
    expect(detail.html).toContain(`Batch #${b.id}`)
    expect(detail.html).toContain('Test Title')
    expect(detail.html).toContain('member public note')
    expect(detail.html).not.toContain('TOP SECRET staff note')
    expect(detail.html).toContain('Withdraw')

    const dash2 = await page(member, '/dashboard')
    expect(dash2.html).toContain(`Batch #${b.id}`)
    expect(dash2.html).toContain('Pending review')

    const nf = await page(member, '/review')
    expect(nf.status).toBe(404)
    expect(nf.html).toContain('Page not found') // our 404, not Next's inline-styled default
    expect((await page(member, `/review/items/${item.id}`)).status).toBe(404)
    expect((await page(member, '/admin')).status).toBe(404)
    // Another member cannot open this batch.
    const other = await loginOk({ id: newId() })
    expect((await page(other, `/batches/${b.id}`)).status).toBe(404)

    // Reviewer/admin views.
    const adminBatch = await page(admin, `/batches/${b.id}`)
    expect(adminBatch.html).toContain('TOP SECRET staff note')
    expect(adminBatch.html).toContain('Staff only')
    const queue = await page(admin, '/review')
    expect(queue.status).toBe(200)
    expect(queue.html).toContain('Test Title')
    const rev = await page(admin, `/review/items/${item.id}`)
    expect(rev.status).toBe(200)
    expect(rev.html).toContain('Deny')
    expect(rev.html).toContain('1General Rotation')
    const adm = await page(admin, '/admin')
    expect(adm.status).toBe(200)
    expect(adm.html).toContain('Reviewer roles')
    expect(adm.html).toContain('1144462744456794153')

    // The race the 409 message is for: the second decision loses.
    expect((await req(admin, `/api/items/${item.id}/decision`, { json: { decision: 'approve' } })).status).toBe(200)
    const lost = await req(admin, `/api/items/${item.id}/decision`, { json: { decision: 'deny', reason: 'late' } })
    expect(lost.status).toBe(409)
    expect(((await lost.json()) as { error: string }).error).toBe('state_changed')
    const decided = await page(admin, `/review/items/${item.id}`)
    expect(decided.html).toContain('no longer pending')
  })

  it('P4 pages: library browse and song detail, archived list, request review', async () => {
    const mediaId = 900000 + (Date.now() % 90000)
    const sql = ownerSql()
    await sql`INSERT INTO library_cache (media_id, unique_id, path, title, artist, album, genre, playlist_ids, length_s)
              VALUES (${mediaId}, ${'u' + mediaId}, ${`Music/Artists/GRIM/GRIM - Smoke ${mediaId}.mp3`}, ${`Smoke ${mediaId}`}, 'GRIM', 'Night', 'House', '{2,77}', 200)`
    await sql`INSERT INTO library_cache (media_id, unique_id, path, title, artist)
              VALUES (${mediaId + 1}, ${'u' + (mediaId + 1)}, ${`UNRELEASED-DO NOT ADD TO ROTATION/Hidden ${mediaId}.mp3`}, ${`Hidden ${mediaId}`}, 'X')`
    const member = await loginOk({ id: newId() })
    const admin = await loginOk({ id: OWNER })
    const [u] = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE discord_id = ${OWNER}`
    await sql`INSERT INTO requests (owner_user_id, kind, media_id, target_path, proposed, reason)
              VALUES (${u!.id}, 'edit', ${mediaId}, ${`Music/Artists/GRIM/GRIM - Smoke ${mediaId}.mp3`}, ${sql.json({ title: 'Smoke Fixed' })}, 'typo')`

    const lib = await page(member, `/library?q=${mediaId}`)
    expect(lib.status).toBe(200)
    expect(lib.html).toContain(`Smoke ${mediaId}`)
    expect((await page(member, `/library?q=Hidden`)).html).not.toContain(`Hidden ${mediaId}`)
    const song = await page(member, `/library/${mediaId}`)
    expect(song.status).toBe(200)
    expect(song.html).toContain('Suggest an edit')
    expect(song.html).not.toContain('Manager tools')
    expect(song.html).not.toContain('1General Rotation') // playlists are staff-only
    expect((await page(member, `/library/${mediaId + 1}`)).status).toBe(404) // outside Music/Artists/**
    expect((await page(member, '/library/archived')).status).toBe(404)
    expect((await page(member, '/review/requests')).status).toBe(404)

    const adminSong = await page(admin, `/library/${mediaId}`)
    expect(adminSong.html).toContain('Manager tools')
    expect(adminSong.html).toContain('Playlist #77') // non-assignable membership shown as kept
    expect((await page(admin, '/library/archived')).status).toBe(200)
    const rq = await page(admin, '/review/requests')
    expect(rq.status).toBe(200)
    expect(rq.html).toContain('Smoke Fixed')
    expect(rq.html).toContain('typo')
  })
})
