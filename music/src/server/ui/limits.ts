// Every upload size, length and format figure the portal's info pages show
// (the home page's "Files and limits", "We can't take", the FAQ and the
// signed-in "Before you upload" card) comes from uploadLimitsForUi(). It
// reads today's compiled constants and the loaded caps, so the page can never
// promise more than the tus route, the probe and the submit page enforce.
// When a limit changes, repoint it HERE; no JSX hard-codes a number.

import { MAX_DURATION_S, MIN_BITRATE, MIN_DURATION_S } from '../../probe/probe'
import { MAX_EDGE } from '../../probe/cover'
import { MAX_TAG_BYTES } from '../../probe/id3scan'
import { MAX_WAV_DURATION_S, MIN_WAV_DURATION_S, OUT_BITRATE } from '../../probe/wav'
import { MAX_ART_BYTES } from '../spool/protocol'
import { DEFAULT_CAPS, MB, type Caps } from '../settings-defaults'

// Same rule as the submit page: a saved cap may be lowered, never raised past
// the compiled default (the tus route enforces the compiled default).
const capOf = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : max)
const count = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback)

const mb = (n: number) => `${Math.round(n / MB)} MB`
const minutes = (s: number) => Math.round(s / 60)
const lengthRange = (minS: number, maxS: number) => `${minS} seconds to ${minutes(maxS)} minutes`
const lengthShort = (minS: number, maxS: number) => `${minS} s–${minutes(maxS)} min`

export type UiUploadLimits = {
  mp3MaxBytes: number
  wavMaxBytes: number
  minSeconds: number
  maxMinutes: number
  wavMaxMinutes: number
  minKbps: number
  wavOutKbps: number
  maxItemsPerBatch: number
  concurrentUploads: number
  // What happens to a WAV (one sentence).
  note: string
  // Ready-made display strings; the page renders these verbatim.
  text: {
    formats: string
    mp3Size: string
    mp3Quality: string
    mp3Length: string
    mp3Tags: string
    mp3Short: string
    wavSize: string
    wavFormat: string
    wavLength: string
    wavConvert: string
    wavShort: string
    artFormats: string
    artSize: string
    artShort: string
    batch: string
    batchShort: string
    refusedFormats: string
    refusedShort: string
    tooLong: string
  }
}

export function uploadLimitsForUi(caps: Partial<Caps> | null | undefined): UiUploadLimits {
  const c = caps ?? {}
  const mp3MaxBytes = capOf(c.maxUploadBytes, DEFAULT_CAPS.maxUploadBytes)
  const wavMaxBytes = capOf(c.maxWavUploadBytes, DEFAULT_CAPS.maxWavUploadBytes)
  const maxItemsPerBatch = count(c.maxItemsPerBatch, DEFAULT_CAPS.maxItemsPerBatch)
  const concurrentUploads = count(c.maxConcurrentUploadsPerUser, DEFAULT_CAPS.maxConcurrentUploadsPerUser)
  const minKbps = Math.round(MIN_BITRATE / 1000)
  const wavOutKbps = Math.round(OUT_BITRATE / 1000)
  const artFormats = 'JPEG, PNG or WebP'
  return {
    mp3MaxBytes,
    wavMaxBytes,
    minSeconds: MIN_DURATION_S,
    maxMinutes: minutes(MAX_DURATION_S),
    wavMaxMinutes: minutes(MAX_WAV_DURATION_S),
    minKbps,
    wavOutKbps,
    maxItemsPerBatch,
    concurrentUploads,
    note: `We convert every WAV to a ${wavOutKbps} kbps MP3 for the station.`,
    text: {
      formats: 'MP3 or WAV',
      mp3Size: `up to ${mb(mp3MaxBytes)}`,
      mp3Quality: `${minKbps} kbps or higher`,
      mp3Length: lengthRange(MIN_DURATION_S, MAX_DURATION_S),
      mp3Tags: `ID3, under ${mb(MAX_TAG_BYTES)} (cover included)`,
      mp3Short: `${mb(mp3MaxBytes)} · ${minKbps} kbps+ · ${lengthShort(MIN_DURATION_S, MAX_DURATION_S)}`,
      wavSize: `up to ${mb(wavMaxBytes)}`,
      wavFormat: 'uncompressed PCM (8, 16, 24 or 32-bit) or 32/64-bit float',
      wavLength: lengthRange(MIN_WAV_DURATION_S, MAX_WAV_DURATION_S),
      wavConvert: `convert it to a ${wavOutKbps} kbps MP3`,
      wavShort: `${mb(wavMaxBytes)} · PCM · ${lengthShort(MIN_WAV_DURATION_S, MAX_WAV_DURATION_S)}`,
      artFormats,
      artSize: `up to ${mb(MAX_ART_BYTES)}, ${MAX_EDGE} px on a side`,
      artShort: `${artFormats} · ${mb(MAX_ART_BYTES)}`,
      batch: `up to ${maxItemsPerBatch} songs, ${concurrentUploads} uploads at once`,
      batchShort: `up to ${maxItemsPerBatch} songs`,
      refusedFormats: 'FLAC, AIFF, M4A, RF64 or other formats',
      refusedShort: 'FLAC, AIFF, M4A',
      tooLong:
        `MP3s over ${mb(mp3MaxBytes)} or WAVs over ${mb(wavMaxBytes)}, songs under ${MIN_DURATION_S} seconds, ` +
        `and songs over ${minutes(MAX_DURATION_S)} minutes (${minutes(MAX_WAV_DURATION_S)} minutes for a WAV).`,
    },
  }
}
