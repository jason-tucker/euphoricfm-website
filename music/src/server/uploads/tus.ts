// tus server (@tus/server v2, FileStore under /staging/uploads).
//
// Ownership is checked in onIncomingRequest on EVERY method that names an
// upload: the DB row's owner_user_id (set from the session at creation) must
// equal the session user of this request; otherwise 404. Client
// Upload-Metadata is discarded. GET (download) is never routed to tus, so
// staged bytes are only ever served by the typed preview route.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { EVENTS, MemoryLocker, Server } from '@tus/server'
import { FileStore } from '@tus/file-store'
import { getDb } from '../db/client'
import { uploads } from '../db/schema'
import { loadEventsSettings } from '../admin/events-settings'
import { webEnv } from '../env'
import { loadCaps } from '../settings'
import { MAX_PROBE_INPUT_BYTES } from '../spool/protocol'
import { admitUpload, declaredKind, UPLOAD_ID_RE } from './caps'

export const TUS_PATH = '/api/uploads'
export const tusContext = new AsyncLocalStorage<{ userId: string }>()

const refuse = (status_code: number, body: string) => ({ status_code, body: `${body}\n` })

const g = globalThis as unknown as { __efmTus?: Server }

export function tusServer(): Server {
  if (g.__efmTus) return g.__efmTus
  const env = webEnv()
  const db = getDb()
  const store = new FileStore({ directory: env.STAGING_UPLOADS_DIR, expirationPeriodInMilliseconds: 24 * 60 * 60 * 1000 })
  // Only what the portal supports: no defer-length, no concatenation, no
  // creation-with-upload (so every byte goes through the PATCH chunk cap).
  store.extensions = ['creation', 'termination', 'expiration']

  const server = new Server({
    path: TUS_PATH,
    datastore: store,
    locker: new MemoryLocker(),
    relativeLocation: true,
    respectForwardedHeaders: false,
    allowedOrigins: [env.PORTAL_ORIGIN],
    // The largest per-file cap (a declared WAV, v0.3.0). The cap for the
    // DECLARED type is enforced at creation (route checkCreateHeaders with
    // the compiled limits, admitUpload with the loaded caps); a PATCH can
    // never change Upload-Length (no defer-length).
    maxSize: MAX_PROBE_INPUT_BYTES,
    disableTerminationForFinishedUploads: true,
    namingFunction: () => randomBytes(16).toString('hex'),
    async onIncomingRequest(req, id) {
      const ctx = tusContext.getStore()
      if (!ctx) throw refuse(401, 'Unauthorized')
      if (!UPLOAD_ID_RE.test(id)) throw refuse(404, 'Not found')
      if (req.method === 'POST') return // row is created in onUploadCreate
      const row = await db.query.uploads.findFirst({ where: eq(uploads.id, id) })
      if (!row || row.ownerUserId !== ctx.userId) throw refuse(404, 'Not found')
      if (req.method === 'PATCH' && row.status !== 'uploading') throw refuse(409, 'Upload not in progress')
      if (req.method === 'DELETE' && row.status !== 'uploading') throw refuse(409, 'Upload not in progress')
    },
    async onUploadCreate(req, upload) {
      const ctx = tusContext.getStore()
      if (!ctx) throw refuse(401, 'Unauthorized')
      // v0.5.0: the events site accepts uploads only while
      // events_uploads_enabled is on, within its own staging budget.
      let site: Parameters<typeof admitUpload>[6] = { site: 'music' }
      if (env.PORTAL_SITE === 'events') {
        const ev = await loadEventsSettings(db)
        if (!ev.events_uploads_enabled) throw refuse(403, 'uploads_disabled')
        site = { site: 'events', eventsBudgetBytes: ev.events_staging_budget_bytes }
      }
      const refusal = await admitUpload(db, ctx.userId, upload.id, upload.size ?? 0, await loadCaps(db), declaredKind(req.headers), site)
      if (refusal) throw refuse(refusal.status, refusal.code)
      // Replace (not merge) whatever the client sent.
      return { metadata: { owner: ctx.userId } }
    },
    async onUploadFinish(_req, upload) {
      const ctx = tusContext.getStore()
      if (!ctx) throw refuse(401, 'Unauthorized')
      await db
        .update(uploads)
        .set({ status: 'complete', completedAt: new Date() })
        .where(and(eq(uploads.id, upload.id), eq(uploads.ownerUserId, ctx.userId), eq(uploads.status, 'uploading')))
      return {}
    },
  })
  server.on(EVENTS.POST_TERMINATE, (_req: unknown, _res: unknown, id: string) => {
    void db.update(uploads).set({ status: 'expired' }).where(eq(uploads.id, id))
  })
  g.__efmTus = server
  return server
}
