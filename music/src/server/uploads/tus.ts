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
import { webEnv } from '../env'
import { DEFAULT_CAPS } from '../settings-defaults'
import { admitUpload, UPLOAD_ID_RE } from './caps'

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
    maxSize: DEFAULT_CAPS.maxUploadBytes,
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
    async onUploadCreate(_req, upload) {
      const ctx = tusContext.getStore()
      if (!ctx) throw refuse(401, 'Unauthorized')
      const refusal = await admitUpload(db, ctx.userId, upload.id, upload.size ?? 0)
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
