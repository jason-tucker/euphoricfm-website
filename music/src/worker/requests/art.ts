// Worker side of the art contract.
//
// STUB BOUNDARY: `uploadArt(mediaId, jpegPath, expectedSha256)` (and an
// optional art read for the old-art hash) belong to the AzuraCast wrapper on
// the foundation fix branch. They are looked up at runtime under the
// contract's exact names, so this compiles and runs before that lands; until
// then apply_art fails with `upload_art_unavailable`. Once merged, call the
// typed methods directly and drop this indirection.

import type { AzuraCastClient, StationMedia } from '../../server/azuracast/client'
import { OpFailed } from './media'

export type ArtCapable = {
  uploadArt(mediaId: number, jpegPath: string, expectedSha256: string): Promise<unknown>
  // GUESSED optional read of the current art (sha256 hex), for restore.
  getArtSha256?(mediaId: number): Promise<string | null>
}

export function artClient(az: AzuraCastClient): ArtCapable {
  const c = az as unknown as Partial<ArtCapable>
  if (typeof c.uploadArt !== 'function') throw new OpFailed('upload_art_unavailable')
  return {
    uploadArt: c.uploadArt.bind(az),
    ...(typeof c.getArtSha256 === 'function' ? { getArtSha256: c.getArtSha256.bind(az) } : {}),
  }
}

// AzuraCast bumps `art_updated_at` (unix s, 0 = no custom art) when art is
// written (P0d-B (f) lists the key). Verification: it must move forward.
export function artStamp(m: StationMedia): number {
  const v = (m as Record<string, unknown>).art_updated_at
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
