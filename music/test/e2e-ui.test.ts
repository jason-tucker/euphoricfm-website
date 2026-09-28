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
import { SITE_LINKS } from '@/components/site-links'
import { DEFAULT_CAPS, type Caps } from '@/server/settings-defaults'
import { uploadLimitsForUi } from '@/server/ui/limits'
import { DEFAULT_RIGHTS } from '@/server/ui/settings'

const E2E_UI = () => has('E2E_WEB_URL', 'MOCKS_CONTROL', 'TEST_OWNER_DATABASE_URL')
const OWNER = '117501528641634310'
// The web may run in the Portal-Test prefix profile (P4 harness sets it).
const ROOT = process.env.PORTAL_TEST_PREFIX ?? '' // PORTAL_OWNER_IDS in test/compose.test.yml → admin
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

// React's text escaping, undone (for comparing rendered text with settings).
const unescapeHtml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&')

// The settings the home page and the submit page both read.
async function homeSettings() {
  const rows = await ownerSql()<{ key: string; value: unknown }[]>`SELECT key, value FROM settings WHERE key IN ('caps', 'rights_attestation', 'discord_invite_url')`
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>
  const r = v.rights_attestation as { text?: unknown } | undefined
  return {
    caps: { ...DEFAULT_CAPS, ...((v.caps as object) ?? {}) } as Caps,
    rightsText: typeof r?.text === 'string' ? r.text : DEFAULT_RIGHTS.text,
    invite: typeof v.discord_invite_url === 'string' ? v.discord_invite_url : SITE_LINKS.discordInvite,
  }
}

const rightsOnHome = (html: string) => unescapeHtml(/<blockquote[^>]*data-testid="rights-text"[^>]*>([^<]*)<\/blockquote>/.exec(html)?.[1] ?? '')

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
    expect(home.html).not.toContain('What do you want to do?')
    expect(home.html).not.toContain('data-testid="how-it-works"') // steps stay open for visitors
    // v0.3.4 home information.
    const cfg = await homeSettings()
    const l = uploadLimitsForUi(cfg.caps)
    for (const t of ['Files, sizes and rights', 'From upload to on air', 'We can’t take', 'Edits and removals', 'Questions artists ask', 'Who can submit', 'At a glance'])
      expect(home.html, t).toContain(t)
    for (const t of [l.text.mp3Size, l.text.mp3Quality, l.text.mp3Length, l.text.wavSize, l.text.wavLength, l.text.wavConvert, l.text.batch, l.note]) expect(home.html, t).toContain(t)
    expect(rightsOnHome(home.html)).toBe(cfg.rightsText)
    expect(home.html).toContain('Sign in to suggest an edit')
    expect(home.html).toContain('Sign in to request removal')
    expect(home.html.match(/<details class="faq"/g) ?? []).toHaveLength(8)
    expect(home.html).toContain(`href="${cfg.invite}"`)
    expect(home.html).toContain(`href="${SITE_LINKS.listen}"`)
    for (const s of ['Pending review', 'Approved', 'Ingesting', 'Verifying', 'Live', 'Denied']) expect(home.html, s).toContain(s)
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

    // v0.3.1 home: action cards + My music counts for this member only.
    const home = await page(member, '/')
    expect(home.status).toBe(200)
    expect(home.html).toContain('What do you want to do?')
    for (const h of ['href="/submit"', 'href="/library?intent=edit"', 'href="/library?intent=remove"']) expect(home.html).toContain(h)
    expect(home.html).toContain('data-count-in-review="0"')
    expect(home.html).toContain('data-testid="how-it-works"')
    expect(home.html).not.toContain('data-testid="review-card"')
    expect(home.html).not.toContain('Sign in with Discord') // no sign-in step for a signed-in member
    expect(home.html).toMatch(/<a[^>]*href="\/library"[^>]*>Library<\/a>/) // nav (v0.3.4: "Library")
    expect(home.html).not.toContain('Edit or remove a song')
    expect(home.html).toContain('Welcome back')
    expect(home.html).toContain('data-testid="before-you-upload"')
    expect(home.html.match(/<details class="faq"/g) ?? []).toHaveLength(8)

    const dash = await page(member, '/dashboard')
    expect(dash.status).toBe(200)
    expect(dash.html).toContain('My music')
    expect(dash.html).toContain('Submit your first songs')
    expect(dash.html).toContain('data-testid="action-bar"')
    expect(dash.html).toContain('Your edit and removal requests')
    expect(dash.html).toContain('data-testid="no-requests"')

    const submit = await page(member, '/submit')
    expect(submit.status).toBe(200)
    expect(submit.html).toContain('Drop MP3 or WAV files here')
    expect(submit.html).toContain('converted to an MP3 for you')
    expect(submit.html).toContain('Big files are converted down (as low as 192 kbps) so they fit.')
    expect(submit.html).toContain('Coming soon')
    expect(submit.html).toContain('Rights statement version')
    // The home page shows the exact statement the submit page asks to confirm.
    const signedOutHome = await page(null, '/')
    const homeRights = rightsOnHome(signedOutHome.html)
    expect(homeRights.length).toBeGreaterThan(0)
    const submitRights = /<span class="text-sm">([^<]*)<span id="rights-version"/.exec(submit.html)?.[1]
    expect(unescapeHtml(submitRights ?? '')).toBe(homeRights)

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
    expect(dash2.html).toContain('1 in review · 0 on air · 0 open requests')
    expect((await page(member, '/')).html).toContain('data-count-in-review="1"')

    const nf = await page(member, '/review')
    expect(nf.status).toBe(404)
    expect(nf.html).toContain('Page not found') // our 404, not Next's inline-styled default
    expect((await page(member, `/review/items/${item.id}`)).status).toBe(404)
    expect((await page(member, '/admin')).status).toBe(404)
    // Another member cannot open this batch.
    const other = await loginOk({ id: newId() })
    expect((await page(other, `/batches/${b.id}`)).status).toBe(404)
    expect((await page(other, '/')).html).toContain('data-count-in-review="0"') // counts are the viewer's own

    // Reviewer/admin views.
    const adminBatch = await page(admin, `/batches/${b.id}`)
    expect(adminBatch.html).toContain('TOP SECRET staff note')
    expect(adminBatch.html).toContain('Staff only')
    const adminHome = await page(admin, '/')
    expect(adminHome.html).toContain('data-testid="review-card"')
    expect(adminHome.html).toMatch(/Review queue.*\d+ songs? and \d+ requests? waiting/s)
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
              VALUES (${mediaId}, ${'u' + mediaId}, ${`${ROOT}Music/Artists/GRIM/GRIM - Smoke ${mediaId}.mp3`}, ${`Smoke ${mediaId}`}, 'GRIM', 'Night', 'House', '{2,77}', 200)`
    await sql`INSERT INTO library_cache (media_id, unique_id, path, title, artist)
              VALUES (${mediaId + 1}, ${'u' + (mediaId + 1)}, ${`${ROOT}UNRELEASED-DO NOT ADD TO ROTATION/Hidden ${mediaId}.mp3`}, ${`Hidden ${mediaId}`}, 'X')`
    const member = await loginOk({ id: newId() })
    const admin = await loginOk({ id: OWNER })
    const [u] = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE discord_id = ${OWNER}`
    await sql`INSERT INTO requests (owner_user_id, kind, media_id, target_path, proposed, reason)
              VALUES (${u!.id}, 'edit', ${mediaId}, ${`${ROOT}Music/Artists/GRIM/GRIM - Smoke ${mediaId}.mp3`}, ${sql.json({ title: 'Smoke Fixed' })}, 'typo')`

    const lib = await page(member, `/library?q=${mediaId}`)
    expect(lib.status).toBe(200)
    expect(lib.html).toContain(`Smoke ${mediaId}`)
    expect((await page(member, `/library?q=Hidden`)).html).not.toContain(`Hidden ${mediaId}`)
    const fix = await page(member, `/library?intent=edit&q=${mediaId}`)
    expect(fix.html).toContain('Pick the song you want to fix')
    expect(fix.html).toContain(`href="/library/${mediaId}?request=edit#request-form"`)
    expect(fix.html).not.toContain('?request=remove')
    const rm = await page(member, `/library?intent=remove&q=${mediaId}`)
    expect(rm.html).toContain('Pick the song you want removed')
    expect(rm.html).toContain(`href="/library/${mediaId}?request=remove#request-form"`)
    expect(lib.html).toContain(`href="/library/${mediaId}?request=edit#request-form"`) // no intent: both buttons
    expect(lib.html).toContain(`href="/library/${mediaId}?request=remove#request-form"`)
    const songRm = await page(member, `/library/${mediaId}?request=remove`)
    expect(songRm.html).toContain('id="request-form"')
    expect(songRm.html).toContain('Ask to remove this song')
    expect(songRm.html).toContain('Send removal request')
    const song = await page(member, `/library/${mediaId}`)
    expect(song.status).toBe(200)
    expect(song.html).toContain('Suggest an edit')
    expect(song.html).not.toContain('Manager tools')
    expect(song.html).not.toContain('1General Rotation') // playlists are staff-only
    expect((await page(member, `/library/${mediaId + 1}`)).status).toBe(404) // outside Music/Artists/**
    // v0.3.3: members reach Archived songs, filtered to their own / linked songs.
    const memberArchived = await page(member, '/library/archived')
    expect(memberArchived.status).toBe(200)
    expect(memberArchived.html).toContain('None of your songs are archived.')
    expect(memberArchived.html).not.toContain('Release…')
    expect((await page(member, '/review/requests')).status).toBe(404)

    const adminSong = await page(admin, `/library/${mediaId}`)
    expect(adminSong.html).toContain('Manager tools')
    expect(adminSong.html).toContain('Playlist #77') // non-assignable membership shown as kept
    expect((await page(admin, '/library/archived')).status).toBe(200)
    const rq = await page(admin, '/review/requests')
    expect(rq.status).toBe(200)
    expect(rq.html).toContain('Smoke Fixed')
    expect(rq.html).toContain('typo')

    // My music links a request to its song page only while that page exists
    // (a song archived some other way would 404).
    await sql`INSERT INTO requests (owner_user_id, kind, media_id, target_path, status, deny_reason)
              VALUES (${u!.id}, 'edit', ${mediaId + 1}, ${`${ROOT}UNRELEASED-DO NOT ADD TO ROTATION/Hidden ${mediaId}.mp3`}, 'denied', 'gone')`
    const adminDash = await page(admin, '/dashboard')
    expect(adminDash.html).toContain(`href="/library/${mediaId}"`)
    expect(adminDash.html).not.toContain(`href="/library/${mediaId + 1}"`)
  })
})
