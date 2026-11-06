// Album art client, matching the server contract exactly (the foundation's
// src/server/art/uploads.ts is authoritative):
//   POST /api/uploads/art          multipart/form-data, exactly one file field
//                                  `art`; 202 {artId, status:'processing'}.
//                                  Refusals: 413 art_too_large, 415
//                                  unsupported_image_type / multipart_required,
//                                  422 unreadable_image_header / image_too_large
//                                  / image_truncated, 400 exactly_one_art_field
//                                  / empty_file, 411 content_length_required,
//                                  408 body_timeout, 429 too_many_art_uploads_processing
//                                  / art_upload_in_progress / art_daily_quota
//                                  or rate_limited, 503 probe_unavailable /
//                                  uploads_paused / art_uploads_busy /
//                                  art_storage_full / staging_full / art_write_failed.
//   GET  /api/uploads/art/:artId   {artId, status:'processing'|'ready'|'rejected'
//                                  |'expired', reason?, previewUrl?, width?, height?}
//   PUT / DELETE /api/items/:id/art           (item art)
//   PUT /api/library/:mediaId/art             (manager; see requests.ts)
//   proposed.artId in edit requests           (requests.ts)

import { api, ApiError } from '@/components/api'

// art_uploads ids are v4 UUIDs.
export type ArtId = string
export type ArtStatus = {
  artId: ArtId
  status: 'processing' | 'ready' | 'rejected' | 'expired'
  reason?: string
  previewUrl?: string
  width?: number
  height?: number
}

export const ART_MAX_BYTES = 5 * 1024 * 1024
export const ART_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const ART_NAME = /\.(jpe?g|png|webp)$/i

// Advisory: the server checks magic bytes, not the client MIME type.
export function precheckArt(file: { name: string; size: number; type: string }): string | null {
  if (!ART_TYPES.includes(file.type) && !ART_NAME.test(file.name)) return 'art_type'
  if (file.size === 0) return 'art_type'
  if (file.size > ART_MAX_BYTES) return 'art_too_large'
  return null
}

// POST /api/uploads/art (multipart, one field `art`) → 202 {artId, status:'processing'}
export function uploadArtFile(file: File) {
  const form = new FormData()
  form.append('art', file)
  return api<{ artId: ArtId; status: string }>('/api/uploads/art', { form })
}

// GET /api/uploads/art/:artId → {artId, status, reason?, previewUrl?}
export function getArtStatus(artId: ArtId) {
  return api<ArtStatus>(`/api/uploads/art/${encodeURIComponent(String(artId))}`)
}

// Polls until the probe has re-encoded the image (ready) or refused it.
export async function waitForArt(artId: ArtId, opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<ArtStatus> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
  for (let i = 0; ; i++) {
    const s = await getArtStatus(artId)
    if (s.status !== 'processing') return s
    if (Date.now() > deadline) throw new ApiError(0, 'art_timeout')
    await sleep(Math.min(500 + i * 250, 2000))
  }
}

// PUT /api/items/:id/art {artId} (409 when the item is no longer pending)
export function setItemArt(itemId: number, artId: ArtId) {
  return api(`/api/items/${itemId}/art`, { method: 'PUT', json: { artId } })
}

// DELETE /api/items/:id/art — back to the embedded cover (if any)
export function clearItemArt(itemId: number) {
  return api(`/api/items/${itemId}/art`, { method: 'DELETE' })
}
