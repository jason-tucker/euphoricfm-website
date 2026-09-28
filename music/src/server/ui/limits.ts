// Every upload size, length and format figure the portal's info pages show
// (the home page's "Files and limits", "We can't take", the FAQ and the
// signed-in "Before you upload" card) comes from uploadLimitsForUi(). It
// reads today's compiled constants and the loaded caps, so the page can never
// promise more than the tus route, the probe and the submit page enforce.
// When a limit changes, repoint it HERE; no JSX hard-codes a number.

import { BITRATE_LADDER, MAX_DURATION_S, MIN_LADDER_BITRATE, maxDurationAt } from '../../lib/fit'
import { MIN_BITRATE, MIN_DURATION_S } from '../../probe/probe'
import { MAX_EDGE, MAX_PIXELS } from '../../probe/cover'
import { MAX_TAG_BYTES } from '../../probe/id3scan'
import { MIN_WAV_DURATION_S } from '../../probe/wav'
import { MAX_ART_BYTES } from '../spool/protocol'
import { DEFAULT_CAPS, MB, type Caps } from '../settings-defaults'

// The input caps by type (v0.3.5 fit-to-size, src/lib/fit.ts): a saved MP3
// (maxMp3UploadBytes) or WAV (maxWavUploadBytes) cap may be lowered, never
// raised past the compiled default (the same rule as loadCaps; tus admission
// and the probe request carry the loaded value). maxUploadBytes is the 35 MB
// FINAL-file cap, not an upload limit: a bigger song is converted down by the
// probe, so it is not shown as a size limit.
const capOf = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : max)
const count = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback)

const mb = (n: number) => `${Math.round(n / MB)} MB`
const minutes = (s: number) => Math.round(s / 60)
const megapixels = (px: number) => Math.round(px / 1_000_000)
const lengthRange = (minS: number, maxS: number) => `${minS} seconds to ${minutes(maxS)} minutes`
const lengthShort = (minS: number, maxS: number) => `${minS} s–${minutes(maxS)} min`

export type UiUploadLimits = {
  mp3MaxBytes: number
  wavMaxBytes: number
  minSeconds: number
  // MP3 and WAV alike: the longest song that fits at the ladder's floor.
  maxMinutes: number
  minKbps: number
  // The fit-to-size ladder (320 / 256 / 192) and its floor.
  ladderKbps: number[]
  minFitKbps: number
  maxItemsPerBatch: number
  concurrentUploads: number
  // What happens to a big file or a WAV (fit-to-size), a few sentences.
  note: string
  // Ready-made display strings; the page renders these verbatim.
  text: {
    formats: string
    mp3Size: string
    mp3Quality: string
    mp3Length: string
    mp3Tags: string
    mp3Fit: string
    mp3Short: string
    wavSize: string
    wavFormat: string
    wavLength: string
    wavConvert: string
    wavShort: string
    fitShort: string
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
  const mp3MaxBytes = capOf(c.maxMp3UploadBytes, DEFAULT_CAPS.maxMp3UploadBytes)
  const wavMaxBytes = capOf(c.maxWavUploadBytes, DEFAULT_CAPS.maxWavUploadBytes)
  const maxItemsPerBatch = count(c.maxItemsPerBatch, DEFAULT_CAPS.maxItemsPerBatch)
  const concurrentUploads = count(c.maxConcurrentUploadsPerUser, DEFAULT_CAPS.maxConcurrentUploadsPerUser)
  const minKbps = Math.round(MIN_BITRATE / 1000)
  const ladderKbps = BITRATE_LADDER.map((b) => b / 1000)
  const minFitKbps = MIN_LADDER_BITRATE / 1000
  // "320 kbps for songs up to 14 minutes, 256 kbps up to 18, 192 kbps up to 24"
  // (whole minutes, rounded down, so the page never promises a higher rate).
  const steps = BITRATE_LADDER.map((b, i) => {
    const m = Math.floor(maxDurationAt(b) / 60)
    return i === 0 ? `${b / 1000} kbps for songs up to ${m} minutes` : `${b / 1000} kbps up to ${m}`
  })
  const ladder = `${ladderKbps.slice(0, -1).join(', ')} or ${minFitKbps} kbps`
  const artFormats = 'JPEG, PNG or WebP'
  return {
    mp3MaxBytes,
    wavMaxBytes,
    minSeconds: MIN_DURATION_S,
    maxMinutes: minutes(MAX_DURATION_S),
    minKbps,
    ladderKbps,
    minFitKbps,
    maxItemsPerBatch,
    concurrentUploads,
    note:
      `Big files are converted down (as low as ${minFitKbps} kbps) so they fit the station: every WAV becomes an MP3 ` +
      `(${steps.join(', ')}), and an MP3 that is too big is re-encoded the same way. An MP3 that already fits is never changed.`,
    text: {
      formats: 'MP3 or WAV',
      mp3Size: `up to ${mb(mp3MaxBytes)}`,
      mp3Quality: `${minKbps} kbps or higher`,
      mp3Length: lengthRange(MIN_DURATION_S, MAX_DURATION_S),
      mp3Tags: `ID3, under ${mb(MAX_TAG_BYTES)} (cover included)`,
      mp3Fit: `kept as is if it fits, otherwise re-encoded down (as low as ${minFitKbps} kbps)`,
      mp3Short: `${mb(mp3MaxBytes)} · ${minKbps} kbps+ · ${lengthShort(MIN_DURATION_S, MAX_DURATION_S)}`,
      wavSize: `up to ${mb(wavMaxBytes)}`,
      wavFormat: 'uncompressed PCM (8, 16, 24 or 32-bit) or 32/64-bit float',
      wavLength: lengthRange(MIN_WAV_DURATION_S, MAX_DURATION_S),
      wavConvert: `convert it to a ${ladder} MP3, the highest that fits`,
      wavShort: `${mb(wavMaxBytes)} · PCM · ${lengthShort(MIN_WAV_DURATION_S, MAX_DURATION_S)}`,
      fitShort: `big files are converted down (as low as ${minFitKbps} kbps) so they fit`,
      artFormats,
      artSize: `up to ${mb(MAX_ART_BYTES)} and ${megapixels(MAX_PIXELS)} megapixels, at most ${MAX_EDGE} px on a side`,
      artShort: `${artFormats} · ${mb(MAX_ART_BYTES)}`,
      batch: `up to ${maxItemsPerBatch} songs, ${concurrentUploads} uploads at once`,
      batchShort: `up to ${maxItemsPerBatch} songs`,
      refusedFormats: 'FLAC, AIFF, M4A, RF64 or other formats',
      refusedShort: 'FLAC, AIFF, M4A',
      tooLong:
        `MP3s over ${mb(mp3MaxBytes)} or WAVs over ${mb(wavMaxBytes)}, songs under ${MIN_DURATION_S} seconds, ` +
        `and songs over ${minutes(MAX_DURATION_S)} minutes (the most that fits even at ${minFitKbps} kbps).`,
    },
  }
}
