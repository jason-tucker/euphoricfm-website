// Tickets Integration API client (worker only; key scopes tickets:read,
// tickets:write, tickets:close, actor_impersonation). Shapes and error codes
// follow euphoric-tickets-web docs/INTEGRATION_API.md v0.12.1.
//
// Staff-only content never crosses: postComment() refuses any comment whose
// visibility is not 'all', independently of the job layer's filter.

import { z } from 'zod'

export class TicketsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterS?: number,
    readonly detail?: unknown,
  ) {
    super(`${status} ${code}`)
    this.name = 'TicketsApiError'
  }
  get retryable(): boolean {
    return (
      this.status === 429 ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 500 ||
      (this.status === 409 && (this.code === 'opening_in_progress' || this.code === 'in_progress'))
    )
  }
}

const visibleAscii = /^[\x21-\x7e]{1,100}$/
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/
const SNOWFLAKE = /^\d{17,20}$/

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0, 'blank')

export function openSchema(portalOrigin: string) {
  return z
    .object({
      categoryKey: z.string().min(1).max(64),
      openerDiscordId: z.string().regex(SNOWFLAKE),
      subject: nonBlank(100),
      card: z
        .object({
          title: z.string().max(100),
          lines: z.array(z.string().max(200)).max(25),
          link: z
            .object({
              label: z.string().min(1).max(40),
              url: z
                .string()
                .max(512)
                .refine((u) => {
                  try {
                    const n = new URL(u)
                    return n.origin === portalOrigin && n.href.length <= 512
                  } catch {
                    return false
                  }
                }, 'link must stay on the portal origin'),
            })
            .strict(),
        })
        .strict(),
      externalRef: z.string().regex(visibleAscii),
    })
    .strict()
}
export type OpenTicketInput = z.infer<ReturnType<typeof openSchema>>

const openResponse = z.object({
  ticketId: z.number().int().positive(),
  number: z.number().int(),
  webUrl: z.string(),
  discordChannelUrl: z.string(),
  created: z.boolean(),
})
export type OpenTicketResult = z.infer<typeof openResponse>

export const messageSchema = z
  .object({
    kind: z.enum(['system', 'comment']),
    body: nonBlank(1800),
    itemRef: z.string().max(100).optional(),
    actorDiscordId: z.string().regex(SNOWFLAKE).optional(),
  })
  .strict()
export type MessageInput = z.infer<typeof messageSchema>

const messageResponse = z.object({
  messageId: z.string(),
  discordMessageId: z.string().nullable(),
  created: z.boolean(),
})

export const TICKET_STATUSES = ['in_progress', 'waiting', 'on_hold', 'completed', 'closed'] as const
const patchSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
    actorDiscordId: z.string().regex(SNOWFLAKE).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()
export type PatchInput = z.infer<typeof patchSchema>

const ticketResponse = z
  .object({
    status: z.string(),
    claimedBy: z.string().nullable(),
    closedAt: z.string().nullable(),
    webUrl: z.string(),
    discordChannelUrl: z.string(),
  })
  .passthrough()

export type CommentForTicket = { id: number; visibility: 'all' | 'staff'; body: string; itemId?: number | null; authorDiscordId?: string | null }

export class TicketsClient {
  private readonly f: typeof fetch
  constructor(
    private readonly opts: { baseUrl: string; key: string; portalOrigin: string; fetchImpl?: typeof fetch },
  ) {
    this.f = opts.fetchImpl ?? fetch
  }

  private async call(method: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}, timeoutMs = 25_000) {
    const res = await this.f(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.key}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, retryAfter: parseRetryAfter(res.headers.get('retry-after')) }
  }

  private fail(r: { status: number; json: unknown; retryAfter?: number }): never {
    const code = (r.json as { error?: unknown } | null)?.error
    throw new TicketsApiError(r.status, typeof code === 'string' ? code : `http_${r.status}`, r.retryAfter, r.json)
  }

  async openTicket(input: OpenTicketInput): Promise<OpenTicketResult> {
    const body = openSchema(this.opts.portalOrigin).parse(input)
    const r = await this.call('POST', '/api/v1/tickets', body, {}, 30_000)
    if (r.status === 201 || r.status === 200) return openResponse.parse(r.json)
    this.fail(r)
  }

  async getTicket(ticketId: number) {
    const r = await this.call('GET', `/api/v1/tickets/${positiveInt(ticketId)}`, undefined)
    if (r.status === 200) return ticketResponse.parse(r.json)
    this.fail(r)
  }

  async postMessage(ticketId: number, input: MessageInput, idempotencyKey: string) {
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) throw new TicketsApiError(0, 'bad_idempotency_key')
    const body = messageSchema.parse(input)
    const r = await this.call('POST', `/api/v1/tickets/${positiveInt(ticketId)}/messages`, body, { 'Idempotency-Key': idempotencyKey })
    if (r.status === 201 || r.status === 200) return messageResponse.parse(r.json)
    this.fail(r)
  }

  // A portal comment → ticket message. Refuses staff-only comments outright.
  async postComment(ticketId: number, c: CommentForTicket) {
    if (c.visibility !== 'all') throw new TicketsApiError(0, 'staff_comment_never_forwarded')
    return this.postMessage(
      ticketId,
      {
        kind: 'comment',
        body: c.body.slice(0, 1800),
        ...(c.itemId ? { itemRef: `item:${c.itemId}` } : {}),
        ...(c.authorDiscordId ? { actorDiscordId: c.authorDiscordId } : {}),
      },
      `comment:${c.id}`,
    )
  }

  async patchTicket(ticketId: number, input: PatchInput) {
    const body = patchSchema.parse(input)
    const r = await this.call('PATCH', `/api/v1/tickets/${positiveInt(ticketId)}`, body)
    if (r.status === 200) return r.json as Record<string, unknown>
    this.fail(r)
  }

  // Close; an already-closed ticket is success (idempotent retries).
  async closeTicket(ticketId: number, opts: { actorDiscordId?: string; reason?: string } = {}) {
    try {
      return await this.patchTicket(ticketId, { status: 'closed', ...opts })
    } catch (e) {
      if (e instanceof TicketsApiError && e.status === 409 && e.code === 'already_closed') return { status: 'closed', alreadyClosed: true }
      throw e
    }
  }
}

function positiveInt(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new TicketsApiError(0, 'bad_ticket_id')
  return n
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v || !/^\d{1,6}$/.test(v)) return undefined
  return Number(v)
}
