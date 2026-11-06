// ID3v2 pre-parse (plan §3.4 step 2), BEFORE music-metadata sees the file:
//   * declared tag size ≤ 5 MB (a huge APIC makes the tag huge → refused);
//   * no compressed (zlib) frames — a tiny compressed frame can inflate to
//     hundreds of MB (the "ID3 zlib bomb") — and no encrypted frames;
//   * no v2.2 CRM (encrypted meta) frames; bounded frame count;
//   * every frame must fit inside the tag.

export const MAX_TAG_BYTES = 5 * 1024 * 1024
export const MAX_FRAMES = 512

export type Id3Verdict = { ok: true; present: boolean; frames: number } | { ok: false; reason: string }

function syncsafe(b: Buffer, o: number): number {
  return ((b[o]! & 0x7f) << 21) | ((b[o + 1]! & 0x7f) << 14) | ((b[o + 2]! & 0x7f) << 7) | (b[o + 3]! & 0x7f)
}

export function scanId3(tag: Buffer | null, declaredTotal: number | null): Id3Verdict {
  if (declaredTotal === null || tag === null) return { ok: true, present: false, frames: 0 }
  if (declaredTotal > MAX_TAG_BYTES) return { ok: false, reason: 'id3_too_large' }
  if (tag.length < 10) return { ok: false, reason: 'id3_truncated' }
  const major = tag[3]!
  const flags = tag[5]!
  if (major === 2 && flags & 0x40) return { ok: false, reason: 'id3_compressed_tag' } // v2.2 whole-tag compression
  const end = Math.min(tag.length, declaredTotal - (major === 4 && flags & 0x10 ? 10 : 0))
  let off = 10
  if (major >= 3 && flags & 0x40) {
    // extended header
    if (off + 4 > end) return { ok: false, reason: 'id3_truncated' }
    const extSize = major === 4 ? syncsafe(tag, off) : tag.readUInt32BE(off) + 4
    if (extSize < 6 || off + extSize > end) return { ok: false, reason: 'id3_bad_ext_header' }
    off += extSize
  }
  let frames = 0
  const headerLen = major === 2 ? 6 : 10
  while (off + headerLen <= end) {
    if (tag[off] === 0x00) break // padding
    const id = tag.toString('latin1', off, off + (major === 2 ? 3 : 4))
    if (!/^[A-Z0-9]{3,4}$/.test(id)) return { ok: false, reason: 'id3_bad_frame_id' }
    let size: number
    let fmtFlags = 0
    if (major === 2) {
      size = (tag[off + 3]! << 16) | (tag[off + 4]! << 8) | tag[off + 5]!
      if (id === 'CRM') return { ok: false, reason: 'id3_encrypted_frame' }
    } else if (major === 3) {
      size = tag.readUInt32BE(off + 4)
      fmtFlags = tag[off + 9]!
      if (fmtFlags & 0x80) return { ok: false, reason: 'id3_compressed_frame' }
      if (fmtFlags & 0x40) return { ok: false, reason: 'id3_encrypted_frame' }
    } else {
      size = syncsafe(tag, off + 4)
      fmtFlags = tag[off + 9]!
      if (fmtFlags & 0x08) return { ok: false, reason: 'id3_compressed_frame' }
      if (fmtFlags & 0x04) return { ok: false, reason: 'id3_encrypted_frame' }
    }
    if (size <= 0 || off + headerLen + size > end) return { ok: false, reason: 'id3_frame_overflow' }
    off += headerLen + size
    if (++frames > MAX_FRAMES) return { ok: false, reason: 'id3_too_many_frames' }
  }
  return { ok: true, present: true, frames }
}
