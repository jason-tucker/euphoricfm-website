// Magic-byte gate (plan §3.4 step 1): the file must be an MPEG-1/2/2.5
// Layer III stream, optionally behind ONE ID3v2 tag and a little zero
// padding. HLS playlists, MP4/Ogg/WAV containers, HTML etc. never reach
// ffprobe.

export const MAX_PADDING = 64 * 1024

export function id3v2TagSize(head: Buffer): number | null {
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null
  const major = head[3]!
  if (major < 2 || major > 4 || head[4] === 0xff) return -1
  const s = [head[6]!, head[7]!, head[8]!, head[9]!]
  if (s.some((b) => b & 0x80)) return -1 // not syncsafe
  const size = (s[0]! << 21) | (s[1]! << 14) | (s[2]! << 7) | s[3]!
  const footer = major === 4 && (head[5]! & 0x10) ? 10 : 0
  return 10 + size + footer
}

// MPEG audio frame header: sync 11 bits, version != reserved, layer III,
// bitrate index 1..14, sample-rate index != 3.
export function isMp3FrameHeader(b: Buffer, off: number): boolean {
  if (off + 4 > b.length) return false
  const b0 = b[off]!
  const b1 = b[off + 1]!
  const b2 = b[off + 2]!
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return false
  const version = (b1 >> 3) & 0x03
  const layer = (b1 >> 1) & 0x03
  const bitrate = (b2 >> 4) & 0x0f
  const rate = (b2 >> 2) & 0x03
  return version !== 0x01 && layer === 0x01 && bitrate !== 0 && bitrate !== 0x0f && rate !== 0x03
}

const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SR: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

export function mp3FrameLength(b: Buffer, off: number): number | null {
  if (!isMp3FrameHeader(b, off)) return null
  const version = (b[off + 1]! >> 3) & 0x03
  const bitrate = (version === 3 ? BR_V1 : BR_V2)[(b[off + 2]! >> 4) & 0x0f]! * 1000
  const rate = SR[version]![(b[off + 2]! >> 2) & 0x03]!
  const padding = (b[off + 2]! >> 1) & 0x01
  const len = Math.floor(((version === 3 ? 144 : 72) * bitrate) / rate) + padding
  return len >= 24 ? len : null
}

export type MagicVerdict = { ok: true; audioOffset: number; id3Size: number } | { ok: false; reason: string }

// `readAt(offset, len)` reads from the (probe-private) copy.
export async function checkMp3Magic(readAt: (offset: number, len: number) => Promise<Buffer>, fileSize: number): Promise<MagicVerdict> {
  const head = await readAt(0, 10)
  let off = 0
  let id3Size = 0
  const tag = id3v2TagSize(head)
  if (tag === -1) return { ok: false, reason: 'bad_id3_header' }
  if (tag !== null) {
    id3Size = tag
    off = tag
  }
  if (off >= fileSize) return { ok: false, reason: 'no_audio' }
  const window = await readAt(off, Math.min(MAX_PADDING + 4, fileSize - off))
  let i = 0
  while (i < window.length && window[i] === 0x00 && i < MAX_PADDING) i++
  if (!isMp3FrameHeader(window, i)) return { ok: false, reason: 'not_mp3' }
  // Require the NEXT frame header exactly where the first one says it ends,
  // so a lone 0xFFFB pair in front of some other format is not enough.
  const len = mp3FrameLength(window, i)
  if (len === null) return { ok: false, reason: 'not_mp3' }
  const next = await readAt(off + i + len, 4)
  if (next.length === 4 && !isMp3FrameHeader(next, 0)) return { ok: false, reason: 'not_mp3' }
  if (next.length < 4 && off + i + len < fileSize) return { ok: false, reason: 'not_mp3' }
  return { ok: true, audioOffset: off + i, id3Size }
}
