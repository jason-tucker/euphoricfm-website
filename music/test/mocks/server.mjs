// Test mocks for the EFM Music Portal (one process, zero dependencies).
//
//   :4100  control API   /__mock/*  (reset, seed, call logs)
//   :4101  Discord       OAuth2 authorize/token, users/@me, guild member
//   :4102  tickets       Integration API v0.12.2 (docs/INTEGRATION_API.md)
//   :4103  AzuraCast     P0d / P0d-B contracts. Music key: station 1 only;
//                        events key (v0.5.0): station 14 only (the events
//                        wrapper's routes); every other station 403s
//   :4104  egress canary records ANY request (proves the probe never calls out)
//
// No production credential is ever used: keys below are test constants.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
// AzuraCast's playlist name → Liquidsoap variable pipeline (TypeScript,
// loaded through Node's type stripping; erasable syntax only).
import { azuracastLiqVarName, isLiquidsoapSafePlaylistName } from '../helpers/azuracast-liq.ts'

const GUILD = process.env.MOCK_GUILD_ID ?? '915830850694815765'
const LINK_ORIGIN = process.env.MOCK_LINK_ORIGIN ?? 'https://music.euphoric.fm'
const EVENTS_LINK_ORIGIN = process.env.MOCK_EVENTS_LINK_ORIGIN ?? 'https://events.euphoric.fm'
const CLIENT_ID = process.env.MOCK_DISCORD_CLIENT_ID ?? 'test-client-id'
const CLIENT_SECRET = process.env.MOCK_DISCORD_CLIENT_SECRET ?? 'test-client-secret'
// One entry per tickets integration: its scopes, whether it may impersonate
// an actor, the categories it may open tickets in and its card link origin.
const TICKETS_KEYS = {
  [process.env.MOCK_TICKETS_WRITE_KEY ?? 'test-tickets-write-key']: {
    name: 'efm-music',
    scopes: ['tickets:read', 'tickets:write', 'tickets:close'],
    actor: true,
    categories: ['newsong', 'songedit', 'songremoval'],
    linkOrigin: LINK_ORIGIN,
  },
  [process.env.MOCK_TICKETS_WEB_KEY ?? 'test-tickets-web-key']: { name: 'efm-music-web', scopes: ['guild:read'], actor: false, categories: [], linkOrigin: LINK_ORIGIN },
  // v0.5.0: the Events portal's outbound-only integration (plan §2 "Tickets").
  [process.env.MOCK_EVENTS_TICKETS_WRITE_KEY ?? 'test-events-tickets-write-key']: {
    name: 'efm-events',
    scopes: ['tickets:write', 'tickets:close'],
    actor: false,
    categories: ['eventrequest'],
    linkOrigin: EVENTS_LINK_ORIGIN,
  },
}
const AZ_KEY = process.env.MOCK_AZURACAST_KEY ?? 'test-azuracast-key-0000'
// v0.5.0: the Events station's own key (role scoped to station 14).
const AZ_EVENTS_KEY = process.env.MOCK_EVENTS_AZURACAST_KEY ?? 'test-events-azuracast-key-0000'
const EVENTS_STATION = 14
// Station-14 playlists created through the API get ids from here (always
// above the wrapper's id floor of 80, never a legacy id).
const FIRST_EVENT_PLAYLIST_ID = 1001
// Category staff sets (INTEGRATION_API v0.12.2): the three reviewer roles.
const STAFF_ROLE_IDS = (process.env.MOCK_STAFF_ROLE_IDS ?? '1144462744456794153,917525862696489001,1145243342620327947').split(',')
const OPENAPI = readFileSync(new URL('../fixtures/openapi-min.yml', import.meta.url), 'utf8')
// The Events station (14) shares storage 2: its legacy playlist ids (live DB,
// station_playlists.station_id = 14). A station-1 batch never touches them,
// nor any station-14 playlist the events key creates (isStation14 below).
const STATION14_LEGACY = [74, 75, 76, 77, 78]
const isStation14 = (id) => state.az.pl14.has(Number(id))

// ------------------------------------------------------------ helpers ----

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string'
  const data = body === undefined ? '' : isText ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': isText ? 'text/plain' : 'application/json', 'content-length': Buffer.byteLength(data), ...headers })
  res.end(data)
}

async function readBody(req, max = 64 * 1024 * 1024) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > max) throw new Error('too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

function json(buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return undefined
  }
}

const redact = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, /authorization|x-api-key/i.test(k) ? '[redacted]' : v]))

// ------------------------------------------------------------- state -----

let state
function reset() {
  state = {
    discord: { users: new Map(), codes: new Map(), tokens: new Map(), refresh: new Map(), log: [] },
    tickets: { calls: [], tickets: new Map(), byRef: new Map(), messages: new Map(), nextId: 100, failNext: [], members: new Map() },
    az: {
      calls: [],
      files: new Map(), // path → media
      unscanned: new Map(), // path → size
      dirs: new Set(), // explicit (empty) dirs
      listCache: new Map(),
      nextId: 5000,
      playlists: new Map([
        [2, '1General Rotation'],
        [3, 'Night'],
        [74, 'Stinger (station 14)'],
        [75, 'ForeverStinger (station 14)'],
        [76, 'default (station 14)'],
        [77, 'Fasion Show (Test) (station 14)'],
        [78, 'Renfair (station 14)'],
      ]),
      superadmin: false,
      drift: false,
      batchErrorsNext: [],
      overwrites: [],
      artUploads: [],
      renames: [],
      nowplaying: null, // P4: {now_playing, playing_next} override
      failNextMove: null, // P4: per-record error string for the next do=move
      ignoreNextPut: false, // a metadata PUT that answers success but stores nothing
      // v0.5.0 Events station (14). pl14: id → full playlist record (the
      // legacy 74–78 plus whatever the events key creates). The names above
      // (`playlists`) stay the single name table for azMedia.
      pl14: new Map(),
      nextPl14: FIRST_EVENT_PLAYLIST_ID,
      nextScheduleId: 1,
      // playlist order: `${playlistId}:${mediaId}` → {entryId, weight}
      order14: new Map(),
      nextEntryId: 1,
      queue14: [], // [{id, song:{…}}]
      nextQueueId: 1,
      restarts14: [], // ISO timestamps of POST /backend/restart
      // GET /status backend_running. Like AzuraCast + supervisord: a restart
      // regenerates the .liq from the ENABLED playlists; a name whose
      // Liquidsoap variable is not a valid identifier (2026-09-29: "~EVT1 s1"
      // → playlist_~evt1_s1) makes Liquidsoap refuse the config ("Error 2:
      // Parse error", no start banner) and the backend stays down.
      backend14: true,
      forceDown14: 0, // the next N restarts leave the backend down whatever the config
      restartErrorsWhenDown14: false, // answer such a restart 500 ("Exited too quickly")
      log14: '2026-09-29 00:00:00 [main:3] Liquidsoap 2.2.5\n2026-09-29 00:00:01 [startup:3] Loaded configuration without errors.\n',
      eventsSuperadmin: false, // the events key may read stations 1 / 7 (self-check refusal tests)
      // Events-key requests the events wrapper must never send (a route or
      // body outside its allowlist). Tests assert this stays empty.
      violations: [],
      dirLinks: new Map(), // folder → [{id, name}] (station folder-playlist links, files/list dir.playlists)
    },
    canary: [],
  }
  for (const id of STATION14_LEGACY) {
    state.az.pl14.set(id, playlistRecord(id, { name: state.az.playlists.get(id), is_enabled: id !== 77, order: 'shuffle' }))
  }
}

// A station-14 playlist as GET /station/14/playlist/{id} answers it (the
// fields the events wrapper reads, plus the pinned ones it writes).
function playlistRecord(id, fields = {}) {
  return {
    id,
    name: `p${id}`,
    type: 'default',
    source: 'songs',
    order: 'shuffle',
    remote_url: null,
    remote_type: null,
    is_jingle: false,
    playback_order: 'shuffle',
    is_enabled: true,
    weight: 3,
    include_in_requests: false,
    include_in_on_demand: false,
    avoid_duplicates: true,
    // AzuraCast keeps backend_options comma-joined and answers explode(','):
    // none reads back as [""] (test/fixtures/azuracast-real/).
    backend_options: [''],
    schedule_items: [],
    ...fields,
    ...('backend_options' in fields ? { backend_options: storedBackendOptions(fields.backend_options) } : {}),
    links: { self: `/api/station/${EVENTS_STATION}/playlist/${id}` },
  }
}

function storedBackendOptions(v) {
  const list = Array.isArray(v) ? v.map(String).filter((x) => x !== '') : []
  return list.length ? list : ['']
}
reset()

// ------------------------------------------------------------ Discord ----

function discordUser(id) {
  return state.discord.users.get(id)
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  return m ? m[1] : null
}

function issueTokens(discordId) {
  const u = discordUser(discordId)
  const access = `acc_${randomBytes(12).toString('hex')}`
  const refresh = `ref_${randomBytes(12).toString('hex')}`
  state.discord.tokens.set(access, { discordId })
  state.discord.refresh.set(refresh, { discordId })
  return { access_token: access, token_type: 'Bearer', expires_in: u?.expiresIn ?? 604800, refresh_token: refresh, scope: 'identify guilds.members.read' }
}

async function handleDiscord(req, res, url) {
  const p = url.pathname
  state.discord.log.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams) })
  if (req.method === 'GET' && p === '/oauth2/authorize') {
    const q = url.searchParams
    const user = q.get('mock_user')
    if (q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code' || !discordUser(user)) return send(res, 400, { error: 'invalid_request' })
    const code = `code_${randomBytes(8).toString('hex')}`
    state.discord.codes.set(code, { discordId: user, challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), scope: q.get('scope') })
    const to = new URL(q.get('redirect_uri'))
    to.searchParams.set('code', code)
    if (q.get('state')) to.searchParams.set('state', q.get('state'))
    res.writeHead(302, { location: to.toString() })
    return res.end()
  }
  if (req.method === 'POST' && p === '/api/oauth2/token') {
    const form = new URLSearchParams((await readBody(req)).toString('utf8'))
    let id = form.get('client_id')
    let secret = form.get('client_secret')
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')
    if (basic) {
      const [a, b] = Buffer.from(basic[1], 'base64').toString('utf8').split(':')
      id = decodeURIComponent(a)
      secret = decodeURIComponent(b)
    }
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return send(res, 401, { error: 'invalid_client' })
    if (form.get('grant_type') === 'authorization_code') {
      const c = state.discord.codes.get(form.get('code'))
      state.discord.codes.delete(form.get('code'))
      if (!c || c.redirectUri !== form.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant' })
      const verifier = form.get('code_verifier') ?? ''
      if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'pkce' })
      return send(res, 200, issueTokens(c.discordId))
    }
    if (form.get('grant_type') === 'refresh_token') {
      const r = state.discord.refresh.get(form.get('refresh_token'))
      if (!r || discordUser(r.discordId)?.refreshFails) return send(res, 400, { error: 'invalid_grant' })
      state.discord.refresh.delete(form.get('refresh_token'))
      return send(res, 200, issueTokens(r.discordId))
    }
    return send(res, 400, { error: 'unsupported_grant_type' })
  }
  const tok = bearer(req)
  const t = tok ? state.discord.tokens.get(tok) : null
  const u = t ? discordUser(t.discordId) : null
  if (req.method === 'GET' && p === '/api/v10/users/@me') {
    if (!u || u.revoked) return send(res, 401, { message: '401: Unauthorized', code: 0 })
    return send(res, 200, { id: u.id, username: u.username, global_name: u.globalName ?? null, avatar: null, discriminator: '0' })
  }
  const m = /^\/api\/v10\/users\/@me\/guilds\/(\d+)\/member$/.exec(p)
  if (req.method === 'GET' && m) {
    if (!u || u.revoked) return send(res, 401, { message: '401: Unauthorized', code: 0 })
    if (u.memberError) return send(res, u.memberError, { message: 'error' })
    if (m[1] !== GUILD || !u.member) return send(res, 404, { message: 'Unknown Guild', code: 10004 })
    return send(res, 200, { roles: u.roles ?? [], pending: Boolean(u.pending), user: { id: u.id }, joined_at: '2024-01-01T00:00:00Z' })
  }
  return send(res, 404, { message: 'not found' })
}

// ------------------------------------------------------------ tickets ----

const SNOW = /^\d{17,20}$/
const VISIBLE = /^[\x21-\x7e]{1,100}$/

function ticketsAuth(req, res, scope) {
  const tok = bearer(req)
  const key = tok ? TICKETS_KEYS[tok] : null
  if (!key) {
    send(res, 401, { error: 'unauthorized' })
    return null
  }
  if (scope && !key.scopes.includes(scope)) {
    send(res, 403, { error: 'scope_missing', required: scope })
    return null
  }
  return key
}

function validationError(res, issues) {
  return send(res, 422, { error: 'validation', issues })
}

function strictKeys(obj, allowed) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every((k) => allowed.includes(k))
}

// v0.12.2: an actor must be a non-pending guild member who is in the
// category's staff set, or the ticket's opener; otherwise 403 actor_forbidden.
function actorAllowed(t, actorId) {
  const m = state.tickets.members.get(actorId)
  if (!m?.member || m.pending) return false
  if (actorId === t.opener) return true
  return (m.roleIds ?? []).some((r) => STAFF_ROLE_IDS.includes(r))
}

function ticketView(t) {
  return { status: t.status, claimedBy: t.claimedBy, closedAt: t.closedAt, webUrl: t.webUrl, discordChannelUrl: t.discordChannelUrl }
}

async function handleTickets(req, res, url) {
  const p = url.pathname
  const bodyBuf = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req, 64 * 1024)
  const body = bodyBuf.length ? json(bodyBuf) : undefined
  state.tickets.calls.push({ method: req.method, path: p, headers: redact(req.headers), body })
  // fail-next entries may name a path; they then apply only to that path.
  const fi = state.tickets.failNext.findIndex((f) => !f.path || f.path === p)
  const fail = fi >= 0 ? state.tickets.failNext.splice(fi, 1)[0] : undefined
  if (fail) return send(res, fail.status, { error: fail.error }, fail.retryAfter ? { 'retry-after': String(fail.retryAfter) } : {})

  const mm = /^\/api\/v1\/members\/(\d+)$/.exec(p)
  if (req.method === 'GET' && mm) {
    if (!ticketsAuth(req, res, 'guild:read')) return
    const m = state.tickets.members.get(mm[1]) ?? { member: false, pending: false, roleIds: [] }
    return send(res, 200, m)
  }
  if (req.method === 'POST' && p === '/api/v1/tickets') {
    const key = ticketsAuth(req, res, 'tickets:write')
    if (!key) return
    if (bodyBuf.length > 13500) return send(res, 413, { error: 'payload_too_large' })
    const b = body
    const issues = []
    if (!strictKeys(b, ['categoryKey', 'openerDiscordId', 'subject', 'card', 'externalRef'])) issues.push({ path: '', message: 'unknown keys' })
    if (typeof b?.subject !== 'string' || !b.subject.trim() || b.subject.length > 100) issues.push({ path: 'subject', message: 'invalid' })
    if (!SNOW.test(b?.openerDiscordId ?? '')) issues.push({ path: 'openerDiscordId', message: 'invalid' })
    if (!VISIBLE.test(b?.externalRef ?? '')) issues.push({ path: 'externalRef', message: 'invalid' })
    const card = b?.card
    if (!strictKeys(card, ['title', 'lines', 'link']) || typeof card?.title !== 'string' || card.title.length > 100) issues.push({ path: 'card', message: 'invalid' })
    if (!Array.isArray(card?.lines) || card.lines.length > 25 || card.lines.some((l) => typeof l !== 'string' || l.length > 200)) issues.push({ path: 'card.lines', message: 'invalid' })
    const link = card?.link
    let originOk = false
    try {
      originOk = new URL(link?.url).origin === key.linkOrigin && link.url.length <= 512
    } catch {
      originOk = false
    }
    if (!strictKeys(link, ['label', 'url']) || typeof link?.label !== 'string' || !link.label || link.label.length > 40 || !originOk) issues.push({ path: 'card.link', message: 'invalid' })
    if (issues.length) return validationError(res, issues)
    if (!key.categories.includes(b.categoryKey)) return send(res, 403, { error: 'category_forbidden' })
    const opener = state.tickets.members.get(b.openerDiscordId)
    if (!opener?.member) return send(res, 404, { error: 'opener_not_member' })
    if (opener.pending) return send(res, 403, { error: 'opener_pending' })
    const existing = state.tickets.byRef.get(`${key.name}|${b.externalRef}`)
    if (existing) {
      const t = state.tickets.tickets.get(existing)
      return send(res, 200, { ticketId: t.id, number: t.number, webUrl: t.webUrl, discordChannelUrl: t.discordChannelUrl, created: false })
    }
    const id = state.tickets.nextId++
    const t = {
      id,
      number: id - 99,
      owner: key.name,
      externalRef: b.externalRef,
      opener: b.openerDiscordId,
      categoryKey: b.categoryKey,
      subject: b.subject,
      card: b.card,
      status: 'open',
      claimedBy: null,
      closedAt: null,
      webUrl: `https://tickets.example.test/b/efm/t/${id}`,
      discordChannelUrl: `https://discord.com/channels/${GUILD}/${1000 + id}`,
    }
    state.tickets.tickets.set(id, t)
    state.tickets.byRef.set(`${key.name}|${b.externalRef}`, id)
    return send(res, 201, { ticketId: id, number: t.number, webUrl: t.webUrl, discordChannelUrl: t.discordChannelUrl, created: true })
  }
  const tm = /^\/api\/v1\/tickets\/(\d+)(\/messages)?$/.exec(p)
  if (tm) {
    const t = state.tickets.tickets.get(Number(tm[1]))
    const needed = req.method === 'GET' ? 'tickets:read' : 'tickets:write'
    const key = ticketsAuth(req, res, needed)
    if (!key) return
    if (!t || t.owner !== key.name) return send(res, 404, { error: 'not_found' })
    if (!tm[2] && req.method === 'GET') return send(res, 200, ticketView(t))
    if (!tm[2] && req.method === 'PATCH') {
      if (!strictKeys(body, ['status', 'actorDiscordId', 'reason']) || !['in_progress', 'waiting', 'on_hold', 'completed', 'closed'].includes(body?.status)) {
        return validationError(res, [{ path: 'status', message: 'invalid' }])
      }
      if (body.actorDiscordId && (!key.actor || !actorAllowed(t, body.actorDiscordId))) return send(res, 403, { error: 'actor_forbidden' })
      if (body.status === 'closed') {
        if (!key.scopes.includes('tickets:close')) return send(res, 403, { error: 'scope_missing', required: 'tickets:close' })
        if (t.status === 'closed') return send(res, 409, { error: 'already_closed' })
        t.status = 'closed'
        t.closedAt = new Date().toISOString()
        return send(res, 200, { ...ticketView(t), closedBy: body.actorDiscordId ? 'actor' : 'bot' })
      }
      t.status = body.status
      return send(res, 200, ticketView(t))
    }
    if (tm[2] && req.method === 'POST') {
      const idem = req.headers['idempotency-key']
      if (typeof idem !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idem)) return validationError(res, [{ path: 'Idempotency-Key', message: 'required' }])
      if (!strictKeys(body, ['kind', 'body', 'itemRef', 'actorDiscordId']) || !['system', 'comment'].includes(body?.kind) || typeof body?.body !== 'string' || !body.body.trim() || body.body.length > 1800) {
        return validationError(res, [{ path: 'body', message: 'invalid' }])
      }
      if (body.itemRef !== undefined && (typeof body.itemRef !== 'string' || body.itemRef.length > 100)) return validationError(res, [{ path: 'itemRef', message: 'invalid' }])
      const k = `${t.id}|${idem}`
      const prior = state.tickets.messages.get(k)
      if (prior) {
        if ((prior.actorDiscordId ?? null) !== (body.actorDiscordId ?? null)) return send(res, 409, { error: 'idempotency_conflict', messageId: prior.messageId })
        return send(res, 200, { messageId: prior.messageId, discordMessageId: prior.discordMessageId, created: false })
      }
      if (t.status === 'closed') return send(res, 409, { error: 'ticket_closed' })
      if (body.actorDiscordId && (!key.actor || !actorAllowed(t, body.actorDiscordId))) return send(res, 403, { error: 'actor_forbidden' })
      const msg = { messageId: randomUUID(), discordMessageId: String(Date.now()), actorDiscordId: body.actorDiscordId ?? null, kind: body.kind, body: body.body, itemRef: body.itemRef ?? null }
      state.tickets.messages.set(k, msg)
      return send(res, 201, { messageId: msg.messageId, discordMessageId: msg.discordMessageId, created: true })
    }
    return send(res, 405, { error: 'method_not_allowed' })
  }
  return send(res, 404, { error: 'not_found' })
}

// ----------------------------------------------------------- AzuraCast ---

// Minimal multipart parser for the art endpoint: the first part that has a
// filename (what PHP's getUploadedFiles() + reset() yields).
function firstMultipartFile(contentType, buf) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!/^multipart\/form-data/i.test(contentType) || !m) return null
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`)
  let at = buf.indexOf(boundary)
  while (at >= 0) {
    const headStart = at + boundary.length + 2
    const headEnd = buf.indexOf('\r\n\r\n', headStart)
    if (headEnd < 0) return null
    const next = buf.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), headEnd)
    if (next < 0) return null
    const head = buf.subarray(headStart, headEnd).toString('latin1')
    const name = /name="([^"]*)"/i.exec(head)?.[1] ?? null
    const filename = /filename="([^"]*)"/i.exec(head)?.[1]
    if (filename !== undefined) return { name, filename, data: Buffer.from(buf.subarray(headEnd + 4, next)) }
    at = next + 2
  }
  return null
}

// AlbumArt::resize + a JPEG encoder: AzuraCast stores a RE-ENCODED copy of
// uploaded art, not the posted bytes. Simulated for a JPEG whose header can
// be read (the dimensions survive, the bytes differ: APPn/COM segments are
// dropped and a COM marker is added). Header-less test bytes, which the real
// decoder would reject, are kept as posted.
function reencodeJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b
  const keep = []
  let o = 2
  let sof = false
  while (o + 4 <= b.length && b[o] === 0xff) {
    const marker = b[o + 1]
    const len = b.readUInt16BE(o + 2)
    if (len < 2 || o + 2 + len > b.length) return b
    if (marker === 0xda) {
      if (!sof) return b
      const com = Buffer.from('mock re-encode', 'latin1')
      const head = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 0])
      head.writeUInt16BE(com.length + 2, 4)
      return Buffer.concat([head, com, ...keep, b.subarray(o)])
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) sof = true
    if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) keep.push(b.subarray(o, o + 2 + len))
    o += 2 + len
  }
  return b
}

function azMedia(f) {
  return {
    id: f.id,
    unique_id: f.unique_id,
    song_id: f.song_id,
    path: f.path,
    mtime: f.mtime,
    uploaded_at: f.uploaded_at,
    length: f.length ?? 35,
    length_text: '0:35',
    title: f.title ?? null,
    artist: f.artist ?? null,
    album: f.album ?? null,
    genre: f.genre ?? null,
    isrc: null,
    lyrics: null,
    custom_fields: {},
    extra_metadata: {},
    // unix seconds; 0 = no custom art (P4 verifies uploads by this moving)
    art_updated_at: f.art_updated_at ?? 0,
    art: `https://euphoric.fm/api/station/euphoricfm/art/${f.unique_id}-${f.art_updated_at ?? 0}.jpg`,
    // Aggregates memberships from EVERY station on the storage (P0d-B (d)).
    playlists: f.playlists.map((id) => ({ id, name: state.az.playlists.get(id) ?? `p${id}`, short_name: `p${id}`, count: 1 })),
    links: { self: `/api/station/1/file/${f.id}` },
  }
}

function dirOf(path) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function buildListing(dir) {
  const prefix = dir === '' ? '' : `${dir}/`
  const entries = []
  const subdirs = new Set()
  const consider = (path) => {
    if (!path.startsWith(prefix)) return null
    const rest = path.slice(prefix.length)
    if (!rest.includes('/')) return 'file'
    subdirs.add(prefix + rest.split('/')[0])
    return null
  }
  for (const d of state.az.dirs) consider(`${d}/.keep`)
  for (const [path, f] of state.az.files) {
    if (consider(path) === 'file') entries.push({ path, path_short: path.slice(prefix.length), text: f.title ?? path, type: 'media', timestamp: f.mtime, size: f.size ?? 481165, media: azMedia(f), dir: null, links: {} })
  }
  for (const [path, size] of state.az.unscanned) {
    if (consider(path) === 'file') entries.push({ path, path_short: path.slice(prefix.length), text: 'File Processing', type: 'other', timestamp: Math.floor(Date.now() / 1000), size, media: null, dir: null, links: {} })
  }
  for (const d of subdirs) entries.push({ path: d, path_short: d.slice(prefix.length), text: d, type: 'directory', timestamp: 0, size: null, media: null, dir: { playlists: state.az.dirLinks.get(d) ?? [] }, links: {} })
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

function listDir(dir, flush) {
  const cached = state.az.listCache.get(dir)
  // Cached for 300 s per directory; only flushCache=true rebuilds (P0d-B (c)).
  if (cached && !flush && Date.now() - cached.at < 300_000) return cached.entries
  const entries = buildListing(dir)
  state.az.listCache.set(dir, { at: Date.now(), entries })
  return entries
}

function azSeed(files) {
  for (const f of files) {
    const id = state.az.nextId++
    state.az.files.set(f.path, {
      id,
      unique_id: randomBytes(12).toString('hex'),
      song_id: randomBytes(16).toString('hex'),
      mtime: 1790000000,
      uploaded_at: 1790000000,
      playlists: [],
      ...f,
      ...{ id },
    })
  }
}

async function handleAzuraCast(req, res, url) {
  const p = url.pathname
  const bodyBuf = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req)
  const body = bodyBuf.length ? json(bodyBuf) : undefined
  // Uploads carry the file as base64 in `file`; a rename's `file` is a path.
  const logged = body && typeof body.file === 'string' && !p.endsWith('/files/rename') ? { ...body, file: `<base64 ${body.file.length} chars>` } : body
  const keyKind = req.headers['x-api-key'] === AZ_KEY ? 'music' : req.headers['x-api-key'] === AZ_EVENTS_KEY ? 'events' : null
  state.az.calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body: logged, apiKey: keyKind === 'music', key: keyKind })

  if (req.method === 'GET' && p === '/api/openapi.yml') {
    const spec = state.az.drift ? OPENAPI.replace("summary: 'Upload a new file.'", "summary: 'Upload a new file (changed).'") : OPENAPI
    return send(res, 200, spec, { 'content-type': 'application/x-yaml' })
  }
  const np = /^\/api\/nowplaying\/([a-z0-9_]+)$/.exec(p)
  if (req.method === 'GET' && np) return send(res, 200, { station: { shortcode: np[1] }, now_playing: { song: { id: 'x' } }, playing_next: null, ...(state.az.nowplaying ?? {}) })

  // Public album art: GET /api/station/{sid}/art/{unique_id|id}[-ts.jpg]
  const ga = /^\/api\/station\/[a-z0-9_]+\/art\/([A-Za-z0-9]+)(?:-\d+\.jpg)?$/.exec(p)
  if (req.method === 'GET' && ga) {
    const f = [...state.az.files.values()].find((x) => x.unique_id === ga[1] || String(x.id) === ga[1])
    if (!f?.artBytes) {
      res.writeHead(302, { location: 'https://euphoric.fm/static/img/generic_song.jpg' })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': f.artBytes.length })
    return res.end(f.artBytes)
  }

  const sm = /^\/api\/station\/(\d+)(\/.*)$/.exec(p)
  if (!sm) return send(res, 404, { code: 404, message: 'Record not found' })
  if (!keyKind) return send(res, 403, { code: 403, message: 'Access denied.' })
  const sid = Number(sm[1])
  if (keyKind === 'events') {
    // Role scoped to station 14 (plan §2). Stations 1 and 7 403 unless a
    // test flips eventsSuperadmin (then they answer a read, which the events
    // self-check must refuse).
    if (sid === EVENTS_STATION) return handleStation14(req, res, url, sm[2], body)
    if (state.az.eventsSuperadmin && req.method === 'GET') return send(res, 200, [])
    return send(res, 403, { code: 403, message: 'You do not have permission to access this portion of the site.' })
  }
  if (sid !== 1 && !(state.az.superadmin && sid === 7)) return send(res, 403, { code: 403, message: 'You do not have permission to access this portion of the site.' })
  const rest = sm[2]

  if (req.method === 'GET' && rest === '/files') {
    const rows = [...state.az.files.values()].sort((a, b) => a.path.localeCompare(b.path)).map(azMedia)
    const perPage = Number(url.searchParams.get('per_page') ?? url.searchParams.get('rowCount') ?? 0)
    if (!perPage) return send(res, 200, rows)
    const page = Math.max(1, Number(url.searchParams.get('page') ?? url.searchParams.get('current') ?? 1))
    const total = rows.length
    const totalPages = Math.max(1, Math.ceil(total / perPage))
    return send(res, 200, { page, per_page: perPage, total, total_pages: totalPages, links: {}, rows: rows.slice((page - 1) * perPage, page * perPage) })
  }
  if (req.method === 'GET' && rest === '/files/list') {
    const dir = url.searchParams.get('currentDirectory') ?? ''
    return send(res, 200, listDir(dir, url.searchParams.get('flushCache') === 'true'))
  }
  const fm = /^\/file\/(\d+)$/.exec(rest)
  if (fm) {
    const f = [...state.az.files.values()].find((x) => x.id === Number(fm[1]))
    if (!f) return send(res, 404, { code: 404, message: 'Record not found' })
    if (req.method === 'GET') return send(res, 200, azMedia(f))
    if (req.method === 'PUT') {
      if (state.az.ignoreNextPut) {
        // The failure mode the portal guards against by re-reading the row:
        // the API reports success, the stored values do not change.
        state.az.ignoreNextPut = false
        return send(res, 200, { success: true, message: 'Record updated successfully.', formatted_message: 'Record updated successfully.' })
      }
      for (const k of ['title', 'artist', 'album', 'genre']) if (typeof body?.[k] === 'string') f[k] = body[k]
      if (Array.isArray(body?.playlists)) f.playlists = body.playlists.map((x) => (typeof x === 'object' ? x.id : x))
      if (typeof body?.path === 'string') {
        state.az.files.delete(f.path)
        f.path = body.path
        state.az.files.set(f.path, f)
      }
      f.mtime = Math.floor(Date.now() / 1000) + 5
      return send(res, 200, { success: true, message: 'Record updated successfully.', formatted_message: 'Record updated successfully.' })
    }
  }
  // POST /api/station/{sid}/art/{media_id} (Stations\Art\PostArtAction,
  // 0.21.0): requireForStation(id) → 404 when unknown; Flow standard upload
  // takes the FIRST multipart file part (OpenAPI names it `file`); the art is
  // resized and stored, art_updated_at is set, and the audio file's tags are
  // rewritten (mtime moves). Answers Status::updated().
  const am = /^\/art\/([A-Za-z0-9]+)$/.exec(rest)
  if (req.method === 'POST' && am) {
    const f = [...state.az.files.values()].find((x) => String(x.id) === am[1] || x.unique_id === am[1])
    if (!f) return send(res, 404, { code: 404, message: 'Record not found' })
    const part = firstMultipartFile(req.headers['content-type'] ?? '', bodyBuf)
    if (!part) return send(res, 500, { code: 500, message: 'No file uploaded.' })
    state.az.artUploads.push({ mediaId: f.id, field: part.name, filename: part.filename, sha256: createHash('sha256').update(part.data).digest('hex'), size: part.data.length })
    f.artBytes = reencodeJpeg(part.data)
    f.art_updated_at = Math.floor(Date.now() / 1000)
    f.mtime = Math.floor(Date.now() / 1000) + 5
    return send(res, 200, { success: true, message: 'Record updated successfully.', formatted_message: 'Record updated successfully.' })
  }

  if (req.method === 'POST' && rest === '/files') {
    if (typeof body?.path !== 'string' || typeof body?.file !== 'string') return send(res, 500, { code: 500, message: 'bad upload' })
    // Stored VERBATIM: no `..` check (P0d-B (a)); only '://' is stripped.
    const path = body.path.replace('://', '')
    const existing = state.az.files.get(path)
    const size = Buffer.from(body.file, 'base64').length
    if (existing) {
      existing.mtime = Math.floor(Date.now() / 1000)
      existing.size = size
      return send(res, 200, azMedia(existing))
    }
    const now = Math.floor(Date.now() / 1000)
    azSeed([{ path, title: 'Portal Test', artist: 'Portal Test', size, mtime: now, uploaded_at: now }])
    state.az.unscanned.delete(path)
    return send(res, 200, azMedia(state.az.files.get(path)))
  }
  // PUT /files/rename (upstream Stations\Files\RenameAction, 0.21.0):
  // {file, newPath}; empty → 500; equal → no-op success; the filesystem
  // move REPLACES an occupied destination (no check) and fails (500) when
  // the source is not on disk; handleRename then points the media row (or an
  // unprocessable entry) at the new path: SAME id, tags untouched.
  // Answers Status::updated().
  if (req.method === 'PUT' && rest === '/files/rename') {
    const from = typeof body?.file === 'string' ? body.file : ''
    const to = typeof body?.newPath === 'string' ? body.newPath : ''
    if (!from) return send(res, 500, { code: 500, message: 'File not specified.' })
    if (!to) return send(res, 500, { code: 500, message: 'New path not specified.' })
    const updated = { success: true, message: 'Record updated successfully.', formatted_message: 'Record updated successfully.' }
    if (from === to) return send(res, 200, updated)
    const f = state.az.files.get(from)
    const unscannedSize = state.az.unscanned.get(from)
    if (!f && unscannedSize === undefined) return send(res, 500, { code: 500, message: `Unable to move file from location ${from} to ${to}.` })
    const victim = state.az.files.get(to)
    if (victim && victim !== f) state.az.overwrites.push({ dest: to, lostId: victim.id, byId: f?.id ?? null })
    if (f) {
      state.az.files.delete(from)
      f.path = to
      state.az.files.set(to, f)
    } else {
      state.az.unscanned.delete(from)
      state.az.unscanned.set(to, unscannedSize)
    }
    state.az.renames.push({ from, to })
    return send(res, 200, updated)
  }
  if (req.method === 'PUT' && rest === '/files/batch') {
    // Mirrors upstream BatchAction (checked against the deployed 0.21.0 source
    // and upstream main): both actions iterate ONLY the DB records whose path
    // is in files[], so a path with no record is skipped silently (no error).
    // doMove has NO destination check: rename() replaces an occupied target.
    // errors[] is populated only by per-record exceptions, which the control
    // API can inject (/__mock/az/batch-errors-next).
    const errors = state.az.batchErrorsNext.splice(0)
    const files = Array.isArray(body?.files) ? body.files : []
    if (body?.do === 'playlist') {
      const ids = []
      for (const x of body.playlists ?? []) {
        if (x === 'new') {
          const id = Math.max(...state.az.playlists.keys()) + 1
          state.az.playlists.set(id, body.new_playlist_name ?? 'New')
          ids.push(id)
        } else ids.push(Number(x))
      }
      if (errors.length === 0) {
        for (const fp of files) {
          const f = state.az.files.get(fp)
          // Replaces THIS station's set; station 14's memberships stay, and
          // ids of station 14 in the request are skipped (findOneBy station).
          if (f) f.playlists = [...f.playlists.filter((id) => isStation14(id)), ...ids.filter((id) => !isStation14(id))]
        }
      }
    } else if (body?.do === 'move') {
      // P4 control: a per-record exception on the next move only (like an
      // upstream Filesystem error); nothing is moved.
      if (state.az.failNextMove && errors.length === 0) {
        for (const fp of files) errors.push(`${fp}: ${state.az.failNextMove}`)
        state.az.failNextMove = null
      }
      for (const fp of errors.length === 0 ? files : []) {
        const f = state.az.files.get(fp)
        if (!f) continue // no DB record: skipped silently, like upstream
        const dest = `${body.directory}/${fp.split('/').pop()}`
        const victim = state.az.files.get(dest)
        if (victim) state.az.overwrites.push({ dest, lostId: victim.id, byId: f.id })
        state.az.files.delete(fp)
        f.path = dest
        state.az.files.set(dest, f) // silently replaces whatever was there
        state.az.dirs.add(dirOf(fp)) // the emptied source folder stays
      }
    } else if (body?.do === 'delete') {
      for (const fp of files) state.az.files.delete(fp)
    } else {
      return send(res, 500, { code: 500, message: 'Unknown action' })
    }
    return send(res, 200, { success: errors.length === 0, errors, files, directories: body?.dirs ?? [], record: null })
  }
  return send(res, 404, { code: 404, message: 'Record not found' })
}

// ------------------------------------------------ AzuraCast station 14 ---
// v0.5.0: what the events key can do on the Events station (the routes of
// src/events/azuracast/allowlist.ts). Station 14 shares storage 2 with
// station 1: same files map, its own playlists. Answers like the real API;
// on top, anything outside the events wrapper's allowlist (route or pinned
// body) is recorded in state.az.violations and NOT applied, so a test can
// prove the wrapper never sent it.

const UPDATED = { success: true, message: 'Record updated successfully.', formatted_message: 'Record updated successfully.' }
const EVENT_UPLOAD_PATH_RE = /^Events\/Uploads\/\d{17,20}\/evt-a[1-9]\d*\.mp3$/
const PLAYLIST_ID_FLOOR = 80

function violation(req, rest, why, body) {
  const b = body && typeof body.file === 'string' ? { ...body, file: `<base64 ${body.file.length} chars>` } : body
  state.az.violations.push({ at: new Date().toISOString(), method: req.method, path: `/api/station/${EVENTS_STATION}${rest}`, why, body: b })
}

// Station-14 order entries of one playlist: one per member file, appended
// (weight = max + 1) when the file joins, dropped when it leaves.
function orderEntries(pid) {
  const members = [...state.az.files.values()].filter((f) => f.playlists.includes(pid))
  const live = new Set(members.map((f) => `${pid}:${f.id}`))
  for (const k of [...state.az.order14.keys()]) if (k.startsWith(`${pid}:`) && !live.has(k)) state.az.order14.delete(k)
  let max = Math.max(0, ...[...state.az.order14.entries()].filter(([k]) => k.startsWith(`${pid}:`)).map(([, v]) => v.weight))
  for (const f of members) {
    const k = `${pid}:${f.id}`
    if (!state.az.order14.has(k)) state.az.order14.set(k, { entryId: state.az.nextEntryId++, weight: ++max })
  }
  // GetOrderAction's rows: station_playlist_media + its media, by weight.
  return members
    .map((f) => ({ f, e: state.az.order14.get(`${pid}:${f.id}`) }))
    .sort((a, b) => a.e.weight - b.e.weight)
    .map(({ f, e }) => ({ playlist_id: pid, media_id: f.id, weight: e.weight, is_queued: true, last_played: 0, id: e.entryId, media: azMedia(f) }))
}

// A playlist body as the events wrapper must send it (plan §4): source
// songs, never remote, never requestable / on-demand, backend options ⊆
// {interrupt, single_track}, every schedule row dated and same-day.
function playlistBodyProblems(b, partial) {
  const out = []
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['not an object']
  if (partial && Object.keys(b).length === 1 && b.is_enabled === false) return out
  if (b.source !== 'songs') out.push('source')
  if (b.include_in_requests !== false) out.push('include_in_requests')
  if (b.include_in_on_demand !== false) out.push('include_in_on_demand')
  if (b.is_jingle !== false) out.push('is_jingle')
  for (const k of Object.keys(b)) if (k.startsWith('remote_')) out.push(k)
  if (!Array.isArray(b.backend_options) || b.backend_options.some((o) => !['interrupt', 'single_track'].includes(o))) out.push('backend_options')
  if (typeof b.name !== 'string' || !b.name || b.name.length > 240) out.push('name')
  if (!Array.isArray(b.schedule_items) || b.schedule_items.length === 0) out.push('schedule_items')
  for (const s of b.schedule_items ?? []) {
    if (!s.start_date || !s.end_date || s.start_date !== s.end_date) out.push('schedule_items.date')
    if (!(Number(s.start_time) < Number(s.end_time))) out.push('schedule_items.time')
  }
  return [...new Set(out)]
}

function withScheduleIds(items) {
  return (items ?? []).map((s) => ({ id: state.az.nextScheduleId++, days: [], loop_once: false, ...s }))
}

function station14Playlists() {
  return [...state.az.pl14.values()].map((p) => ({ ...p, num_songs: [...state.az.files.values()].filter((f) => f.playlists.includes(p.id)).length }))
}

async function handleStation14(req, res, url, rest, body) {
  const m = req.method
  if (m === 'GET' && rest === '/playlists') return send(res, 200, station14Playlists())
  const pm = /^\/playlist\/(\d+)(\/order)?$/.exec(rest)
  if (pm) {
    const id = Number(pm[1])
    const pl = state.az.pl14.get(id)
    if (!pl) {
      if (m !== 'GET') violation(req, rest, 'write to a playlist that is not on station 14', body)
      return send(res, 404, { code: 404, message: 'Record not found' })
    }
    if (pm[2]) {
      // Get/PutOrderAction: only a sequential songs playlist has an order.
      if (pl.source !== 'songs' || pl.order !== 'sequential') return send(res, 500, { code: 500, message: 'This playlist is not a sequential playlist.' })
      if (m === 'GET') return send(res, 200, orderEntries(id))
      if (m === 'PUT') {
        if (id <= PLAYLIST_ID_FLOOR) {
          violation(req, rest, 'order write on a legacy playlist', body)
          return send(res, 403, { code: 403, message: 'refused by mock' })
        }
        const entries = orderEntries(id)
        const sent = body?.order
        // setMediaOrder: foreach ($order as $id => $weight) UPDATE weight
        // WHERE playlist_id AND id. A JSON list arrives as 0 => …, 1 => …,
        // matches no row, changes nothing, and is echoed with a 200.
        if (Array.isArray(sent)) {
          violation(req, rest, 'order body is a list (AzuraCast reads a {entry id: weight} map; a list updates nothing)', body)
          return send(res, 200, sent)
        }
        const pairs = sent && typeof sent === 'object' ? Object.entries(sent).map(([k, w]) => [Number(k), Number(w)]) : null
        const known = new Set(entries.map((e) => e.id))
        const weights = (pairs ?? []).map(([, w]) => w)
        if (!pairs || pairs.length !== entries.length || pairs.some(([k]) => !known.has(k)) || new Set(weights).size !== weights.length || weights.some((w) => !Number.isInteger(w) || w < 1 || w > entries.length)) {
          violation(req, rest, 'order map is not a permutation of the playlist entries with weights 1..n', body)
          return send(res, 500, { code: 500, message: 'bad order' })
        }
        const byEntry = new Map([...state.az.order14.entries()].filter(([k]) => k.startsWith(`${id}:`)).map(([k, v]) => [v.entryId, k]))
        for (const [entryId, w] of pairs) state.az.order14.get(byEntry.get(entryId)).weight = w
        return send(res, 200, sent)
      }
    } else {
      if (m === 'GET') return send(res, 200, station14Playlists().find((p) => p.id === id))
      if (m === 'PUT' || m === 'DELETE') {
        if (id <= PLAYLIST_ID_FLOOR) {
          violation(req, rest, `${m} on a legacy playlist (id <= ${PLAYLIST_ID_FLOOR})`, body)
          return send(res, 403, { code: 403, message: 'refused by mock' })
        }
      }
      if (m === 'PUT') {
        const problems = playlistBodyProblems(body, true)
        if (problems.length) {
          violation(req, rest, `playlist body: ${problems.join(', ')}`, body)
          return send(res, 400, { code: 400, message: 'refused by mock' })
        }
        const { schedule_items: items, ...fields } = body
        Object.assign(pl, fields)
        if ('backend_options' in fields) pl.backend_options = storedBackendOptions(fields.backend_options)
        // setScheduleItems: rows sent without an id replace the old ones
        if (items) pl.schedule_items = withScheduleIds(items)
        if (typeof fields.name === 'string') state.az.playlists.set(id, fields.name)
        return send(res, 200, UPDATED)
      }
      if (m === 'DELETE') {
        state.az.pl14.delete(id)
        state.az.playlists.delete(id)
        for (const f of state.az.files.values()) f.playlists = f.playlists.filter((x) => x !== id)
        orderEntries(id)
        return send(res, 200, { success: true, message: 'Record deleted successfully.', formatted_message: 'Record deleted successfully.' })
      }
    }
  }
  if (m === 'POST' && rest === '/playlists') {
    const problems = playlistBodyProblems(body, false)
    if (problems.length) {
      violation(req, rest, `playlist body: ${problems.join(', ')}`, body)
      return send(res, 400, { code: 400, message: 'refused by mock' })
    }
    const id = state.az.nextPl14++
    const { schedule_items: items, ...fields } = body
    const pl = playlistRecord(id, { ...fields, schedule_items: withScheduleIds(items) })
    state.az.pl14.set(id, pl)
    state.az.playlists.set(id, pl.name)
    return send(res, 200, { ...pl, num_songs: 0 })
  }
  if (m === 'GET' && rest === '/files/list') return send(res, 200, listDir(url.searchParams.get('currentDirectory') ?? '', url.searchParams.get('flushCache') === 'true'))
  const fm = /^\/file\/(\d+)$/.exec(rest)
  if (fm) {
    const f = [...state.az.files.values()].find((x) => x.id === Number(fm[1]))
    if (!f) return send(res, 404, { code: 404, message: 'Record not found' })
    if (m === 'GET') return send(res, 200, { ...azMedia(f), links: { self: `/api/station/${EVENTS_STATION}/file/${f.id}` } })
    if (m === 'PUT') {
      const keys = Object.keys(body ?? {})
      if (!f.path.startsWith('Events/Uploads/') || keys.some((k) => !['title', 'artist', 'album', 'genre'].includes(k))) {
        violation(req, rest, 'metadata PUT outside Events/Uploads or with keys beyond title/artist/album/genre', body)
        return send(res, 403, { code: 403, message: 'refused by mock' })
      }
      for (const k of keys) if (typeof body[k] === 'string') f[k] = body[k]
      f.mtime = Math.floor(Date.now() / 1000) + 5
      return send(res, 200, UPDATED)
    }
    if (m === 'DELETE') {
      if (!EVENT_UPLOAD_PATH_RE.test(f.path)) {
        violation(req, rest, `file DELETE outside Events/Uploads: ${f.path}`, body)
        return send(res, 403, { code: 403, message: 'refused by mock' })
      }
      state.az.files.delete(f.path)
      return send(res, 200, { success: true, message: 'Record deleted successfully.', formatted_message: 'Record deleted successfully.' })
    }
  }
  if (m === 'POST' && rest === '/files') {
    if (typeof body?.path !== 'string' || typeof body?.file !== 'string') return send(res, 500, { code: 500, message: 'bad upload' })
    if (!EVENT_UPLOAD_PATH_RE.test(body.path)) {
      violation(req, rest, `upload outside Events/Uploads: ${body.path}`, body)
      return send(res, 403, { code: 403, message: 'refused by mock' })
    }
    const size = Buffer.from(body.file, 'base64').length
    const existing = state.az.files.get(body.path)
    if (existing) {
      existing.mtime = Math.floor(Date.now() / 1000)
      existing.size = size
      return send(res, 200, azMedia(existing))
    }
    const now = Math.floor(Date.now() / 1000)
    azSeed([{ path: body.path, title: 'Uploaded', artist: 'Uploaded', size, mtime: now, uploaded_at: now }])
    return send(res, 200, azMedia(state.az.files.get(body.path)))
  }
  if (m === 'PUT' && rest === '/files/batch') {
    if (body?.do !== 'playlist') {
      violation(req, rest, `batch do=${body?.do}`, body)
      return send(res, 403, { code: 403, message: 'refused by mock' })
    }
    const files = Array.isArray(body.files) ? body.files : []
    // Upstream BatchAction on station 14: for each file, its memberships in
    // THIS station's playlists are replaced by the listed ids (ids of other
    // stations are skipped); other stations' memberships stay untouched.
    const ids = (body.playlists ?? []).map(Number).filter((id) => isStation14(id))
    for (const fp of files) {
      const f = state.az.files.get(fp)
      if (!f) continue
      const before14 = f.playlists.filter((id) => isStation14(id))
      const droppedLegacy = before14.filter((id) => id <= PLAYLIST_ID_FLOOR && !ids.includes(id))
      if (droppedLegacy.length) violation(req, rest, `batch dropped legacy membership ${droppedLegacy.join(',')} of ${fp}`, body)
      f.playlists = [...f.playlists.filter((id) => !isStation14(id)), ...ids]
      for (const id of ids) orderEntries(id)
    }
    return send(res, 200, { success: true, errors: [], files, directories: body.dirs ?? [], record: null })
  }
  // StationQueueDetailed rows carry no `id`: each is addressed by links.self.
  if (m === 'GET' && rest === '/queue') {
    return send(
      res,
      200,
      state.az.queue14.map(({ id, ...q }) => ({ cued_at: 0, played_at: 0, duration: 180, playlist: null, is_request: false, sent_to_autodj: false, is_played: false, autodj_custom_uri: null, log: null, ...q, links: { self: `https://euphoric.fm/api/station/${EVENTS_STATION}/queue/${id}` } })),
    )
  }
  const qm = /^\/queue\/(\d+)$/.exec(rest)
  if (qm && m === 'DELETE') {
    const i = state.az.queue14.findIndex((q) => q.id === Number(qm[1]))
    if (i < 0) return send(res, 404, { code: 404, message: 'Record not found' })
    state.az.queue14.splice(i, 1)
    return send(res, 200, { success: true, message: 'Record deleted successfully.', formatted_message: 'Record deleted successfully.' })
  }
  if (m === 'GET' && rest === '/status') return send(res, 200, { backend_running: state.az.backend14, frontend_running: true, station_has_started: state.az.backend14, station_needs_restart: false })
  if (m === 'POST' && rest === '/backend/restart') {
    state.az.restarts14.push(new Date().toISOString())
    const bad = [...state.az.pl14.values()].filter((p) => p.is_enabled && !isLiquidsoapSafePlaylistName(p.name)).map((p) => azuracastLiqVarName(p.name))
    const forced = state.az.forceDown14 > 0
    if (forced) state.az.forceDown14--
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    if (bad.length > 0 || forced) {
      state.az.backend14 = false
      state.az.log14 += bad.length > 0 ? `At line 212, char 9-10:\nError 2: Parse error (${bad[0]} = playlist(...))\n` : 'Error 4: Invalid value\n'
      if (state.az.restartErrorsWhenDown14) return send(res, 500, { code: 500, message: 'Exited too quickly' })
      return send(res, 200, { success: true, message: 'Backend restarted.', formatted_message: 'Backend restarted.' })
    }
    state.az.backend14 = true
    state.az.log14 += `${stamp} [main:3] Liquidsoap 2.2.5\n${stamp} [startup:3] Loaded configuration without errors.\n`
    return send(res, 200, { success: true, message: 'Backend restarted.', formatted_message: 'Backend restarted.' })
  }
  if (m === 'GET' && rest === '/logs') return send(res, 200, [{ key: 'liquidsoap_log', name: 'Liquidsoap Log', tail: true, links: { self: `/api/station/${EVENTS_STATION}/log/liquidsoap_log` } }])
  const lm = /^\/log\/([a-z0-9_]+)$/.exec(rest)
  if (lm && m === 'GET') {
    if (lm[1] !== 'liquidsoap_log') return send(res, 404, { code: 404, message: 'Record not found' })
    return send(res, 200, { contents: state.az.log14, eof: true, position: state.az.log14.length })
  }
  violation(req, rest, 'route outside the events allowlist', body)
  return send(res, 404, { code: 404, message: 'Record not found' })
}

// ------------------------------------------------------------- control ---

async function handleControl(req, res, url) {
  const p = url.pathname
  const body = req.method === 'GET' ? undefined : json(await readBody(req))
  if (p === '/__mock/reset') {
    reset()
    return send(res, 200, { ok: true })
  }
  if (p === '/__mock/discord/user' && req.method === 'POST') {
    const prev = state.discord.users.get(body.id) ?? {}
    state.discord.users.set(body.id, { username: `user${body.id.slice(-4)}`, member: true, pending: false, roles: [], ...prev, ...body })
    return send(res, 200, state.discord.users.get(body.id))
  }
  if (p === '/__mock/discord/log') return send(res, 200, state.discord.log)
  if (p === '/__mock/tickets/member' && req.method === 'POST') {
    state.tickets.members.set(body.id, { member: body.member ?? true, pending: body.pending ?? false, roleIds: body.roleIds ?? [] })
    return send(res, 200, { ok: true })
  }
  if (p === '/__mock/tickets/fail-next' && req.method === 'POST') {
    state.tickets.failNext.push(body)
    return send(res, 200, { ok: true })
  }
  if (p === '/__mock/tickets/calls') return send(res, 200, state.tickets.calls)
  if (p === '/__mock/tickets/tickets') return send(res, 200, [...state.tickets.tickets.values()])
  if (p === '/__mock/tickets/messages') return send(res, 200, [...state.tickets.messages.entries()].map(([k, v]) => ({ key: k, ...v })))
  if (p === '/__mock/az/calls') return send(res, 200, state.az.calls)
  if (p === '/__mock/az/seed' && req.method === 'POST') {
    azSeed(body.files ?? [])
    return send(res, 200, { ok: true })
  }
  // Simulates CheckMediaTask dropping a row whose file it missed (P3 recovery tests).
  if (p === '/__mock/az/drop' && req.method === 'POST') {
    state.az.files.delete(body.path)
    return send(res, 200, { ok: true })
  }
  if (p === '/__mock/az/unscanned' && req.method === 'POST') {
    state.az.unscanned.set(body.path, body.size ?? 481166)
    return send(res, 200, { ok: true })
  }
  if (p === '/__mock/az/mode' && req.method === 'POST') {
    Object.assign(state.az, { superadmin: Boolean(body.superadmin), drift: Boolean(body.drift) })
    return send(res, 200, { ok: true })
  }
  if (p === '/__mock/az/batch-errors-next' && req.method === 'POST') {
    state.az.batchErrorsNext.push(...(body.errors ?? []))
    return send(res, 200, { ok: true })
  }
  if (p === '/__mock/az/overwrites') return send(res, 200, state.az.overwrites)
  if (p === '/__mock/az/renames') return send(res, 200, state.az.renames)
  if (p === '/__mock/az/art-uploads') return send(res, 200, state.az.artUploads)
  if (p === '/__mock/az/nowplaying' && req.method === 'POST') {
    state.az.nowplaying = body && Object.keys(body).length ? body : null
    return send(res, 200, { ok: true })
  }
  if (p === '/__mock/az/ignore-next-put' && req.method === 'POST') {
    state.az.ignoreNextPut = true
    return send(res, 200, { ok: true })
  }
  // Someone adds (or removes) the file in an Events (station 14) playlist in
  // AzuraCast: sets only its station-14 memberships, like that station's own
  // playlist UI would (the station-1 API cannot).
  if (p === '/__mock/az/station14' && req.method === 'POST') {
    const f = state.az.files.get(body.path)
    if (!f) return send(res, 404, { error: 'no such path' })
    const ids = (body.playlists ?? []).map(Number).filter((id) => isStation14(id))
    f.playlists = [...f.playlists.filter((id) => !isStation14(id)), ...ids]
    return send(res, 200, azMedia(f))
  }
  if (p === '/__mock/az/fail-next-move' && req.method === 'POST') {
    state.az.failNextMove = body?.error ?? 'Filesystem error.'
    return send(res, 200, { ok: true })
  }
  // A scan that lost the row and re-imported the file from disk: new id,
  // metadata read back from the (unchanged) tags, no playlist memberships.
  if (p === '/__mock/az/lose-row' && req.method === 'POST') {
    const old = state.az.files.get(body.path)
    if (!old) return send(res, 404, { error: 'no such path' })
    state.az.files.delete(body.path)
    azSeed([{ path: body.path, title: body.title ?? 'Scanned Title', artist: body.artist ?? 'Scanned Artist', album: body.album ?? null, genre: body.genre ?? null, playlists: [] }])
    return send(res, 200, azMedia(state.az.files.get(body.path)))
  }
  if (p === '/__mock/az/files') return send(res, 200, [...state.az.files.values()].map(azMedia))
  // ---- v0.5.0 Events station (14) ----
  // Lets the events key read stations 1 / 7 (the events self-check must refuse).
  if (p === '/__mock/az/events-mode' && req.method === 'POST') {
    state.az.eventsSuperadmin = Boolean(body?.superadmin)
    return send(res, 200, { ok: true })
  }
  // Everything a test needs to inspect on station 14 in one read.
  if (p === '/__mock/az/station14/state') {
    return send(res, 200, {
      playlists: station14Playlists(),
      order: Object.fromEntries([...state.az.pl14.keys()].map((id) => [id, orderEntries(id).map((e) => e.media.id)])),
      queue: state.az.queue14,
      restarts: state.az.restarts14,
      backendRunning: state.az.backend14,
      log: state.az.log14,
      violations: state.az.violations,
      dirLinks: Object.fromEntries(state.az.dirLinks),
    })
  }
  if (p === '/__mock/az/station14/violations') return send(res, 200, state.az.violations)
  // Seed a station-14 playlist directly (e.g. another event's, or a foreign one).
  if (p === '/__mock/az/station14/playlist' && req.method === 'POST') {
    const id = body?.id ?? state.az.nextPl14++
    const pl = playlistRecord(id, { ...(body ?? {}), id, schedule_items: withScheduleIds(body?.schedule_items) })
    state.az.pl14.set(id, pl)
    state.az.playlists.set(id, pl.name)
    return send(res, 200, pl)
  }
  // Put tracks in the station-14 queue ({count} or {items}).
  if (p === '/__mock/az/station14/queue' && req.method === 'POST') {
    const items = body?.items ?? Array.from({ length: body?.count ?? 1 }, (_, i) => ({ song: { text: `Queued ${i + 1}` } }))
    for (const it of items) state.az.queue14.push({ ...it, id: state.az.nextQueueId++ })
    return send(res, 200, state.az.queue14)
  }
  // The station-14 backend: {running?, forceDown?, restartErrorsWhenDown?}.
  if (p === '/__mock/az/station14/backend' && req.method === 'POST') {
    if (typeof body?.running === 'boolean') state.az.backend14 = body.running
    if (Number.isInteger(body?.forceDown)) state.az.forceDown14 = body.forceDown
    if (typeof body?.restartErrorsWhenDown === 'boolean') state.az.restartErrorsWhenDown14 = body.restartErrorsWhenDown
    return send(res, 200, { running: state.az.backend14, forceDown: state.az.forceDown14, restartErrorsWhenDown: state.az.restartErrorsWhenDown14 })
  }
  if (p === '/__mock/az/station14/log' && req.method === 'POST') {
    state.az.log14 = typeof body?.contents === 'string' ? body.contents : state.az.log14
    return send(res, 200, { ok: true })
  }
  // A station's folder→playlist link as files/list reports it (dir.playlists).
  if (p === '/__mock/az/dir-links' && req.method === 'POST') {
    if (body?.playlists?.length) state.az.dirLinks.set(body.dir, body.playlists)
    else state.az.dirLinks.delete(body?.dir)
    state.az.listCache.clear()
    return send(res, 200, { ok: true })
  }
  if (p === '/__mock/canary/hits') return send(res, 200, state.canary)
  return send(res, 404, { error: 'unknown control path' })
}

// keepAliveTimeout 0: the mocks never idle-close a keep-alive socket. Node's
// default (5 s, the same as music-web's: Next's standalone server keeps Node's
// default unless KEEP_ALIVE_TIMEOUT is set, and compose sets none) let the
// server close a pooled socket just as a client (undici in the tests, the
// worker's AzuraCast/tickets clients) wrote the next request to it: "other side
// closed" (UND_ERR_SOCKET). With no server timeout the CLIENT always closes
// first (undici's own idle timeout, 4 s with no Keep-Alive hint), so that race
// cannot happen on any mock-bound request.
function serve(port, handler) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    handler(req, res, url).catch((e) => send(res, 500, { error: String(e?.message ?? e) }))
  })
  server.keepAliveTimeout = 0
  server.listen(port, '0.0.0.0')
}

serve(4100, handleControl)
serve(4101, handleDiscord)
serve(4102, handleTickets)
serve(4103, handleAzuraCast)
serve(4104, async (req, res, url) => {
  state.canary.push({ method: req.method, path: url.pathname, at: Date.now() })
  send(res, 200, '#EXTM3U\n')
})
console.log('[mocks] listening on 4100-4104')
