// WAV input (v0.3.0). A member may upload a WAV instead of an MP3; the probe
// checks it as strictly as an MP3 and CONVERTS it here, in the network-less
// container, to a CBR MP3 that then replaces the WAV under the same upload
// id. Everything downstream (prefill, review, finalize, AzuraCast) only ever
// sees that MP3.
//
// Order (all on the probe-private, read-only copy):
//   1. magic bytes: RIFF....WAVE only (RF64 / BW64 / RIFX refused by name);
//   2. a bounded RIFF chunk walk in JS, BEFORE any parser runs: every chunk
//      inside the RIFF, the RIFF inside the file (truncated or lying sizes
//      are refused), bytes after the RIFF all zero or chunks under the
//      same rules (ffmpeg reads to EOF), ≤64 chunks, exactly one 'fmt '
//      before exactly one 'data', PCM / IEEE-float only (incl. WAVE_FORMAT_EXTENSIBLE carrying
//      them), sane channels / rate / block align, duration bounds; LIST/INFO
//      sub-chunks must tile their LIST exactly, and an 'id3 ' chunk goes
//      through the same ID3 pre-scan as an MP3's tag (≤5 MB, no compressed /
//      encrypted frames);
//   3. ffprobe -f wav (file/pipe protocols, 1 thread) must agree with the
//      header: one PCM audio stream, same channels / rate / duration;
//   4. music-metadata (heap-capped child) reads LIST/INFO and 'id3 ' tags
//      and an embedded APIC, which takes the same hardened cover path;
//   5. ffmpeg -f wav → libmp3lame CBR at nice 19, under prlimit + timeout,
//      at the highest ladder rate (320 → 256 → 192 kbps, v0.3.2) whose MP3
//      fits the final-file cap with its cover and tags (src/lib/fit.ts);
//      >2 channels are downmixed to stereo, a rate other than 44.1 / 48 kHz
//      is resampled (to 48 kHz for multiples of 48 kHz, else 44.1 kHz);
//   6. the MP3 is checked like an uploaded one (magic, ffprobe -f mp3, the
//      chosen bitrate, duration within 1 s of the WAV's, ≤ the audio budget).
//
// The duration cap is MAX_DURATION_S (fit.ts, 24 min), the same as an MP3's:
// the longest song whose 192 kbps MP3 still fits. (v0.3.0 had 15 min, the
// longest that fitted at a fixed 320 kbps.)

import { z } from 'zod'
import { MAX_DURATION_S } from '../lib/fit'
import { MAX_TAG_BYTES } from './id3scan'
import { ProbeReject } from './files'

export const MIN_WAV_DURATION_S = 30 // same as the MP3 rule (probe.ts MIN_DURATION_S)
export const MIN_WAV_RATE = 8000
export const MAX_WAV_RATE = 192_000
export const MAX_WAV_CHANNELS = 8
export const MAX_WAV_CHUNKS = 64
// Chunks music-metadata reads into memory (LIST/INFO values, CSET) and the
// ones it skips are all bounded; 'data' is the only large chunk.
export const MAX_WAV_LIST_BYTES = 1024 * 1024
export const MAX_WAV_INFO_ITEMS = 256
export const MAX_WAV_OTHER_CHUNK_BYTES = 16 * 1024 * 1024
export const MAX_WAV_FMT_BYTES = 1024
// Bytes after the RIFF's declared end (a pad byte, zero padding, a chunk some
// tools append). ffmpeg parses them, so scanWav checks them (all zero, or
// chunks under the in-RIFF rules); more than this is refused.
export const MAX_WAV_TRAILING_BYTES = 64 * 1024

// ffmpeg + libmp3lame peak at ~152 MB of address space (measured, 5.1 24-bit
// downmix and 96 kHz resample); RSS ~42 MB. The same limits apply to the
// MP3 → MP3 re-encode (v0.3.2, transcode.ts).
export const CONVERT_VMEM_KB = 256 * 1024
// v0.3.2: sized for the largest inputs (a 250 MB WAV, a 100 MB MP3 of up to
// 24 min) on the 1-vCPU botvps, where the probe has cpu_shares 256 and runs
// ffmpeg at nice 19: CHANGELOG [0.3.2] has the measured times.
export const CONVERT_TIMEOUT_S = 600
export const CONVERT_NICE = 19

export const PCM_CODECS = new Set(['pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le'])

export type WavSniff = 'wav' | 'rf64' | 'rifx' | null

export function sniffWav(head: Buffer): WavSniff {
  if (head.length < 12) return null
  const riff = head.toString('latin1', 0, 4)
  const wave = head.toString('latin1', 8, 12)
  if (wave !== 'WAVE') return null
  if (riff === 'RIFF') return 'wav'
  if (riff === 'RF64' || riff === 'BW64') return 'rf64'
  if (riff === 'RIFX') return 'rifx'
  return null
}

export type WavFmt = {
  formatTag: number // effective: 1 = integer PCM, 3 = IEEE float
  extensible: boolean
  channels: number
  sampleRate: number
  byteRate: number
  blockAlign: number
  bitsPerSample: number
}

export type WavInfo = {
  fmt: WavFmt
  dataOffset: number
  dataSize: number
  durationS: number
  id3: { offset: number; size: number } | null
  chunks: string[]
}

const GUID_TAIL = Buffer.from([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71])

function chunkId(b: Buffer): string | null {
  for (let i = 0; i < 4; i++) if (b[i]! < 0x20 || b[i]! > 0x7e) return null
  return b.toString('latin1', 0, 4)
}

export function parseFmt(b: Buffer): WavFmt {
  if (b.length < 16) throw new ProbeReject('wav_bad_fmt')
  const tag = b.readUInt16LE(0)
  const channels = b.readUInt16LE(2)
  const sampleRate = b.readUInt32LE(4)
  const byteRate = b.readUInt32LE(8)
  const blockAlign = b.readUInt16LE(12)
  const bits = b.readUInt16LE(14)
  let formatTag = tag
  let extensible = false
  if (tag === 0xfffe) {
    // WAVE_FORMAT_EXTENSIBLE: cbSize ≥ 22, valid bits ≤ container, and a
    // KSDATAFORMAT_SUBTYPE_{PCM,IEEE_FLOAT} GUID.
    if (b.length < 40 || b.readUInt16LE(16) < 22) throw new ProbeReject('wav_bad_fmt')
    const valid = b.readUInt16LE(18)
    if (valid === 0 || valid > bits) throw new ProbeReject('wav_bad_fmt')
    if (!b.subarray(28, 40).equals(GUID_TAIL)) throw new ProbeReject('wav_codec_unsupported')
    formatTag = b.readUInt32LE(24)
    extensible = true
  }
  const okBits = formatTag === 1 ? [8, 16, 24, 32] : formatTag === 3 ? [32, 64] : null
  if (!okBits) throw new ProbeReject('wav_codec_unsupported') // ADPCM, MP3-in-WAV, GSM, A-law, µ-law, …
  if (!okBits.includes(bits)) throw new ProbeReject('wav_codec_unsupported')
  if (channels < 1 || channels > MAX_WAV_CHANNELS) throw new ProbeReject('wav_channels')
  if (sampleRate < MIN_WAV_RATE || sampleRate > MAX_WAV_RATE) throw new ProbeReject('wav_sample_rate')
  if (blockAlign !== channels * (bits / 8) || byteRate !== sampleRate * blockAlign) throw new ProbeReject('wav_bad_fmt')
  return { formatTag, extensible, channels, sampleRate, byteRate, blockAlign, bitsPerSample: bits }
}

// LIST/INFO: 8-byte headers, each value padded to even, tiling the list
// exactly (music-metadata refuses anything else, and reads each value into
// memory, so every declared size must stay inside the bounded LIST).
export function checkInfoList(body: Buffer): void {
  let off = 4 // after the list type
  let n = 0
  while (off < body.length) {
    if (off + 8 > body.length) throw new ProbeReject('wav_bad_list')
    const size = body.readUInt32LE(off + 4)
    const padded = size + (size & 1)
    if (off + 8 + padded > body.length) throw new ProbeReject('wav_bad_list')
    off += 8 + padded
    if (++n > MAX_WAV_INFO_ITEMS) throw new ProbeReject('wav_bad_list')
  }
}

// The bounded chunk walk. `readAt(offset, len)` reads the private copy.
//
// The walk goes to the END OF THE FILE, not just the RIFF: ffmpeg's wav
// demuxer ignores the RIFF size and keeps reading chunks to EOF (music-
// metadata stops at the RIFF end), so a chunk after the RIFF (an 'id3 ' tag
// with a zlib bomb, a second id3 chunk, LIST, bext, …) would otherwise reach
// ffmpeg's parsers unchecked. Bytes after the RIFF (≤ MAX_WAV_TRAILING_BYTES)
// must therefore be either all zero (ffmpeg reads size-0 chunks of tag 0 and
// ignores them) or chunks under exactly the rules inside the RIFF, sharing
// the chunk count and the single-id3 rule; fewer than 8 bytes (a pad byte)
// never form a chunk header and are not parsed by anyone.
export async function scanWav(readAt: (offset: number, len: number) => Promise<Buffer>, fileSize: number): Promise<WavInfo> {
  if (fileSize < 44) throw new ProbeReject('wav_truncated')
  const head = await readAt(0, 12)
  if (sniffWav(head) !== 'wav') throw new ProbeReject('not_wav')
  const riffSize = head.readUInt32LE(4)
  // 0 / 0xFFFFFFFF: a header written for a pipe or a live recording whose
  // sizes were never filled in. Refused (as a truncated file would be) but
  // with its own reason, so the member knows re-exporting fixes it.
  if (riffSize === 0 || riffSize === 0xffffffff) throw new ProbeReject('wav_unfinalized')
  if (riffSize < 4) throw new ProbeReject('wav_bad_riff')
  const riffEnd = 8 + riffSize
  if (riffEnd > fileSize) throw new ProbeReject('wav_truncated')
  if (fileSize - riffEnd > MAX_WAV_TRAILING_BYTES) throw new ProbeReject('wav_trailing_data')

  let fmt: WavFmt | null = null
  let data: { offset: number; size: number } | null = null
  let id3: { offset: number; size: number } | null = null
  const chunks: string[] = []
  let off = 12
  while (off + 8 <= fileSize) {
    // A header not wholly inside the RIFF is in the trailing region (a
    // header straddling riffEnd is read by ffmpeg exactly like one after it).
    const trailing = off + 8 > riffEnd
    if (trailing) {
      const rest = await readAt(off, fileSize - off) // ≤ MAX_WAV_TRAILING_BYTES + 7
      if (rest.length < fileSize - off) throw new ProbeReject('wav_truncated')
      if (rest.every((b) => b === 0)) break
    }
    const h = await readAt(off, 8)
    if (h.length < 8) throw new ProbeReject('wav_truncated')
    const id = chunkId(h)
    if (id === null) throw new ProbeReject(trailing ? 'wav_trailing_data' : 'wav_bad_chunk')
    const size = h.readUInt32LE(4)
    const body = off + 8
    const end = body + size
    // A chunk may omit its pad byte only at the very end of the RIFF (or,
    // after the RIFF, of the file).
    if (end > (trailing ? fileSize : riffEnd)) {
      if (id === 'data' && size === 0xffffffff) throw new ProbeReject('wav_unfinalized')
      throw new ProbeReject(trailing ? 'wav_trailing_data' : 'wav_truncated')
    }
    if (chunks.push(id) > MAX_WAV_CHUNKS) throw new ProbeReject('wav_too_many_chunks')
    if (id === 'fmt ') {
      if (fmt || data) throw new ProbeReject('wav_bad_fmt')
      if (size > MAX_WAV_FMT_BYTES) throw new ProbeReject('wav_bad_fmt')
      fmt = parseFmt(await readAt(body, size))
    } else if (id === 'data') {
      if (!fmt || data) throw new ProbeReject('wav_bad_data')
      if (size === 0) throw new ProbeReject('wav_no_audio')
      data = { offset: body, size }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      if (id3) throw new ProbeReject('wav_bad_id3')
      if (size > MAX_TAG_BYTES) throw new ProbeReject('id3_too_large')
      id3 = { offset: body, size }
    } else if (id === 'LIST') {
      if (size > MAX_WAV_LIST_BYTES || size < 4) throw new ProbeReject('wav_bad_list')
      const b = await readAt(body, size)
      if (b.length < size) throw new ProbeReject('wav_truncated')
      if (b.toString('latin1', 0, 4) === 'INFO') checkInfoList(b)
    } else if (size > MAX_WAV_OTHER_CHUNK_BYTES) {
      throw new ProbeReject('wav_chunk_too_large')
    }
    off = end + (size & 1)
  }
  if (!fmt) throw new ProbeReject('wav_bad_fmt')
  if (!data) throw new ProbeReject('wav_bad_data')
  if (data.size < fmt.blockAlign) throw new ProbeReject('wav_no_audio')
  const durationS = data.size / fmt.byteRate
  if (durationS < MIN_WAV_DURATION_S) throw new ProbeReject('too_short')
  if (durationS > MAX_DURATION_S) throw new ProbeReject('wav_too_long')
  return { fmt, dataOffset: data.offset, dataSize: data.size, durationS, id3, chunks }
}

export function wavFfprobeArgs(file: string): string[] {
  return [
    '-hide_banner',
    '-v', 'error',
    '-protocol_whitelist', 'file,pipe',
    '-f', 'wav',
    '-threads', '1',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    `file:${file}`,
  ]
}

const wavFfprobeOut = z.object({
  streams: z.array(
    z
      .object({
        codec_type: z.string(),
        codec_name: z.string().optional(),
        channels: z.number().int().optional(),
        sample_rate: z.string().optional(),
        duration: z.string().optional(),
        disposition: z.object({ attached_pic: z.number().optional() }).passthrough().optional(),
      })
      .passthrough(),
  ),
  format: z.object({ format_name: z.string(), duration: z.string().optional() }).passthrough(),
})

// ffprobe must see exactly what the header walk saw: exactly one audio
// stream. The only other stream allowed is the attached picture ffmpeg
// exposes for an APIC in an 'id3 ' chunk (never decoded here: covers come
// from music-metadata through cover.ts, and the conversion maps 0:a:0 only).
export function judgeWavFfprobe(json: unknown, info: WavInfo): { durationS: number; codec: string } {
  const r = wavFfprobeOut.safeParse(json)
  if (!r.success) throw new ProbeReject('ffprobe_unparseable')
  const { streams, format } = r.data
  if (format.format_name !== 'wav') throw new ProbeReject('not_wav')
  const audio = streams.filter((s) => s.codec_type === 'audio')
  if (audio.length !== 1) throw new ProbeReject('wav_not_single_stream')
  if (streams.some((s) => s.codec_type !== 'audio' && (s.codec_type !== 'video' || s.disposition?.attached_pic !== 1))) throw new ProbeReject('wav_not_single_stream')
  const s = audio[0]!
  if (!s.codec_name || !PCM_CODECS.has(s.codec_name)) throw new ProbeReject('wav_codec_unsupported')
  if (s.channels !== info.fmt.channels || Number(s.sample_rate) !== info.fmt.sampleRate) throw new ProbeReject('wav_header_mismatch')
  const durationS = Number(format.duration ?? s.duration)
  if (!Number.isFinite(durationS)) throw new ProbeReject('no_duration')
  if (Math.abs(durationS - info.durationS) > 1) throw new ProbeReject('wav_header_mismatch')
  if (durationS < MIN_WAV_DURATION_S) throw new ProbeReject('too_short')
  if (durationS > MAX_DURATION_S) throw new ProbeReject('wav_too_long')
  return { durationS, codec: s.codec_name }
}

// 44.1 / 48 kHz are kept; multiples of 48 kHz (96, 144, 192 kHz) go to 48 kHz;
// every other rate (88.2, 176.4, 22.05, 32 kHz, …) to 44.1 kHz.
export function targetRate(sampleRate: number): number {
  if (sampleRate === 44100 || sampleRate === 48000) return sampleRate
  return sampleRate % 48000 === 0 ? 48000 : 44100
}

// `bitrate`: the ladder rate fit.ts pickBitrate chose (bits per second).
export function convertArgs(input: string, output: string, fmt: Pick<WavFmt, 'channels' | 'sampleRate'>, bitrate: number): string[] {
  if (!Number.isInteger(bitrate) || bitrate < 8000 || bitrate > 320_000 || bitrate % 1000 !== 0) throw new Error('convertArgs: bad bitrate')
  const rate = targetRate(fmt.sampleRate)
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-protocol_whitelist', 'file,pipe',
    '-threads', '1',
    '-filter_threads', '1',
    '-f', 'wav', '-i', `file:${input}`,
    '-map', '0:a:0',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-vn', '-sn', '-dn',
    ...(fmt.channels > 2 ? ['-ac', '2'] : []),
    ...(rate !== fmt.sampleRate ? ['-ar', String(rate)] : []),
    '-c:a', 'libmp3lame',
    '-b:a', `${bitrate / 1000}k`,
    '-threads', '1',
    '-id3v2_version', '0',
    '-write_id3v1', '0',
    '-f', 'mp3',
    `file:${output}`,
  ]
}
