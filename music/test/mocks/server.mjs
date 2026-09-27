// Test mocks for the EFM Music Portal (one process, zero dependencies).
//
//   :4100  control API   /__mock/*  (reset, seed, call logs)
//   :4101  Discord       OAuth2 authorize/token, users/@me, guild member
//   :4102  tickets       Integration API v0.12.2 (docs/INTEGRATION_API.md)
//   :4103  AzuraCast     P0d / P0d-B contracts (station 1 only; others 403)
//   :4104  egress canary records ANY request (proves the probe never calls out)
//
// No production credential is ever used: keys below are test constants.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const GUILD = process.env.MOCK_GUILD_ID ?? '915830850694815765'
const LINK_ORIGIN = process.env.MOCK_LINK_ORIGIN ?? 'https://music.euphoric.fm'
const CLIENT_ID = process.env.MOCK_DISCORD_CLIENT_ID ?? 'test-client-id'
const CLIENT_SECRET = process.env.MOCK_DISCORD_CLIENT_SECRET ?? 'test-client-secret'
const TICKETS_KEYS = {
  [process.env.MOCK_TICKETS_WRITE_KEY ?? 'test-tickets-write-key']: { name: 'efm-music', scopes: ['tickets:read', 'tickets:write', 'tickets:close'], actor: true },
  [process.env.MOCK_TICKETS_WEB_KEY ?? 'test-tickets-web-key']: { name: 'efm-music-web', scopes: ['guild:read'], actor: false },
}
const AZ_KEY = process.env.MOCK_AZURACAST_KEY ?? 'test-azuracast-key-0000'
// Category staff sets (INTEGRATION_API v0.12.2): the three reviewer roles.
const STAFF_ROLE_IDS = (process.env.MOCK_STAFF_ROLE_IDS ?? '1144462744456794153,917525862696489001,1145243342620327947').split(',')
const OPENAPI = readFileSync(new URL('../fixtures/openapi-min.yml', import.meta.url), 'utf8')

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
        [74, 'Events A (station 14)'],
        [75, 'Events B (station 14)'],
      ]),
      superadmin: false,
      drift: false,
      batchErrorsNext: [],
      overwrites: [],
      artUploads: [],
    },
    canary: [],
  }
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
      originOk = new URL(link?.url).origin === LINK_ORIGIN && link.url.length <= 512
    } catch {
      originOk = false
    }
    if (!strictKeys(link, ['label', 'url']) || typeof link?.label !== 'string' || !link.label || link.label.length > 40 || !originOk) issues.push({ path: 'card.link', message: 'invalid' })
    if (issues.length) return validationError(res, issues)
    if (!['newsong', 'songedit', 'songremoval'].includes(b.categoryKey)) return send(res, 403, { error: 'category_forbidden' })
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
    if (consider(path) === 'file') entries.push({ path, path_short: path.slice(prefix.length), text: f.title ?? path, type: 'media', timestamp: f.mtime, size: 481165, media: azMedia(f), dir: null, links: {} })
  }
  for (const [path, size] of state.az.unscanned) {
    if (consider(path) === 'file') entries.push({ path, path_short: path.slice(prefix.length), text: 'File Processing', type: 'other', timestamp: Math.floor(Date.now() / 1000), size, media: null, dir: null, links: {} })
  }
  for (const d of subdirs) entries.push({ path: d, path_short: d.slice(prefix.length), text: d, type: 'directory', timestamp: 0, size: null, media: null, dir: { playlists: [] }, links: {} })
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
  const logged = body && typeof body.file === 'string' ? { ...body, file: `<base64 ${body.file.length} chars>` } : body
  state.az.calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body: logged, apiKey: req.headers['x-api-key'] === AZ_KEY })

  if (req.method === 'GET' && p === '/api/openapi.yml') {
    const spec = state.az.drift ? OPENAPI.replace("summary: 'Upload a new file.'", "summary: 'Upload a new file (changed).'") : OPENAPI
    return send(res, 200, spec, { 'content-type': 'application/x-yaml' })
  }
  const np = /^\/api\/nowplaying\/([a-z0-9_]+)$/.exec(p)
  if (req.method === 'GET' && np) return send(res, 200, { station: { shortcode: np[1] }, now_playing: { song: { id: 'x' } }, playing_next: null })

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
  if (req.headers['x-api-key'] !== AZ_KEY) return send(res, 403, { code: 403, message: 'Access denied.' })
  const sid = Number(sm[1])
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
    f.artBytes = part.data
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
    azSeed([{ path, title: 'Portal Test', artist: 'Portal Test', size }])
    state.az.unscanned.delete(path)
    return send(res, 200, azMedia(state.az.files.get(path)))
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
          if (f) f.playlists = [...f.playlists.filter((id) => id >= 70), ...ids] // replace this station's set; other stations' stay
        }
      }
    } else if (body?.do === 'move') {
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
  if (p === '/__mock/az/art-uploads') return send(res, 200, state.az.artUploads)
  if (p === '/__mock/az/files') return send(res, 200, [...state.az.files.values()].map(azMedia))
  if (p === '/__mock/canary/hits') return send(res, 200, state.canary)
  return send(res, 404, { error: 'unknown control path' })
}

function serve(port, handler) {
  createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    handler(req, res, url).catch((e) => send(res, 500, { error: String(e?.message ?? e) }))
  }).listen(port, '0.0.0.0')
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
