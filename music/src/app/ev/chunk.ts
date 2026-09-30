import { getDb } from '@/server/db/client'
import { loadCaps } from '@/server/settings'
import { DEFAULT_CAPS } from '@/server/settings-defaults'

// The tus chunk size for My audio uploads (the My audio page and the inline
// uploads of the request form): the portal's (admin-lowerable) cap; the
// events config does not carry it.
export async function uploadChunkBytes(): Promise<number> {
  try {
    return Math.min((await loadCaps(getDb())).chunkBytes, DEFAULT_CAPS.chunkBytes)
  } catch {
    return DEFAULT_CAPS.chunkBytes
  }
}
