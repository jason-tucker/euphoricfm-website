// Album art client (contract: scratchpad art-contract.md, 2026-09-27). The
// server parts are being built on other branches, so every route here is
// written from the contract text and none exists on this branch yet:
//   foundation  POST /api/uploads/art, GET /api/uploads/art/:artId
//   P3          PUT / DELETE /api/items/:id/art
//   P4          PUT /api/library/:mediaId/art   (see requests.ts: setLibraryArt)
//               proposed.artId in edit requests (requests.ts: fileEditRequest)

import { api, ApiError } from '@/components/api'

export type ArtId = string | number
export type ArtStatus = { artId: ArtId; status: 'processing' | 'ready' | 'rejected'; reason?: string; previewUrl?: string }

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
