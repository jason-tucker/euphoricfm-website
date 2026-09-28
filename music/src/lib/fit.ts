// Fit-to-size (v0.3.2): every song the portal ships must fit the final-file
// cap, so the probe converts a too-big song DOWN instead of rejecting it.
//
// Pure constants and functions (no Node imports): the probe, the web, the
// worker, the UI texts and the tests all read the same numbers from here.
//
// Why the cap: the portal sends the finished file to AzuraCast's JSON
// POST /files route (base64 inside JSON), whose nginx / PHP 50M body limit
// allows a final file of about 37.5 MiB. MAX_UPLOAD_BYTES (35 MiB) is the
// portal's final-file cap, and finalize, the worker and the JSON route stay
// sized for it. The final file is the audio PLUS the cover finalize embeds
// (≤ MAX_FINAL_COVER_BYTES) PLUS the ID3 frames finalize writes, so the audio
// itself gets AUDIO_BUDGET_BYTES.
//
// The rule (owner decision, 2026-09-27):
//   * an MP3 whose audio already fits is kept untouched (no re-encode,
//     whatever its bitrate): "never degrade a file that already fits";
//   * anything else (a bigger MP3, or any WAV) is encoded to a CBR MP3 at the
//     HIGHEST ladder rate (320 → 256 → 192 kbps) whose size fits;
//   * a song that would not fit even at 192 kbps is rejected (MAX_DURATION_S).

export const MIB = 1024 * 1024

// The final-file cap (finalize's input cap, the worker's upload, AzuraCast).
export const MAX_UPLOAD_BYTES = 35 * MIB
// Input caps by ACTUAL type (magic bytes). The web caps a tus upload by its
// DECLARED type; the probe re-checks by the real one.
export const MAX_MP3_UPLOAD_BYTES = 100 * MIB
export const MAX_WAV_UPLOAD_BYTES = 250 * MIB

// The cover finalize embeds (its copy cap, src/probe/finalize.ts: 2 MiB).
export const MAX_FINAL_COVER_BYTES = 2 * MIB
// The rest of the ID3 tag finalize writes: header + TIT2 / TPE1 / TALB /
// TCON (≤ 200 UTF-16 code units each, ≤ ~420 bytes) + the APIC frame's own
// header, MIME type and description. About 2 KB in the worst case; 16 KiB.
export const TAG_MARGIN_BYTES = 16 * 1024
// Bytes the MP3 stream may need beyond duration × bitrate / 8: the encoder's
// Xing/LAME info frame (≤ 1441 B), its start/end padding frames, and the
// info frame finalize's `-c copy` strip writes again. A few KB; 16 KiB.
export const CONTAINER_MARGIN_BYTES = 16 * 1024

// What the audio stream of the final file may take (34,586,624 B).
export const AUDIO_BUDGET_BYTES = MAX_UPLOAD_BYTES - MAX_FINAL_COVER_BYTES - TAG_MARGIN_BYTES
// Duration × bitrate / 8 (or an untouched MP3's audio bytes) must stay within
// this (34,570,240 B), leaving CONTAINER_MARGIN_BYTES for the stream's own
// overhead.
export const AUDIO_PAYLOAD_BYTES = AUDIO_BUDGET_BYTES - CONTAINER_MARGIN_BYTES

export const BITRATE_LADDER = [320_000, 256_000, 192_000] as const
export type LadderBitrate = (typeof BITRATE_LADDER)[number]
export const MIN_LADDER_BITRATE: LadderBitrate = 192_000

// The longest song (whole seconds) whose CBR MP3 at `bps` fits:
// 320k → 864 s (14.4 min), 256k → 1080 s (18.0 min), 192k → 1440 s (24.0 min).
export function maxDurationAt(bps: number): number {
  return Math.floor((AUDIO_PAYLOAD_BYTES * 8) / bps)
}

// The duration cap for MP3 and WAV alike: the longest song that fits at the
// ladder's floor (1440 s = 24 min).
export const MAX_DURATION_S = maxDurationAt(MIN_LADDER_BITRATE)
export const MAX_DURATION_MIN = Math.floor(MAX_DURATION_S / 60)

// The highest ladder rate at which a song of `durationS` fits, or null when
// it does not fit even at the floor.
export function pickBitrate(durationS: number): LadderBitrate | null {
  if (!Number.isFinite(durationS) || durationS < 0) return null
  for (const r of BITRATE_LADDER) if (durationS <= maxDurationAt(r)) return r
  return null
}

// An uploaded MP3 is kept untouched when its audio (the file without the
// leading ID3v2 tag, which finalize strips and replaces) fits the payload,
// and the whole file fits finalize's input cap (MAX_UPLOAD_BYTES).
export function mp3FitsUntouched(size: number, id3Size: number): boolean {
  return size <= MAX_UPLOAD_BYTES && size - Math.max(0, id3Size) <= AUDIO_PAYLOAD_BYTES
}

// What the member and the reviewers see about a converted song. `kbps` null
// on a WAV item probed before v0.3.2 means 320 (the only rate then).
export function transcodeLabel(inputFormat: string | null | undefined, kbps: number | null | undefined): string | null {
  if (inputFormat === 'wav') return `Converted from WAV (${kbps ?? 320} kbps MP3)`
  if (kbps) return `Re-encoded to ${kbps} kbps to fit`
  return null
}

export const mibOf = (bytes: number) => Math.round(bytes / MIB)

// "MP3 up to 100 MB or WAV up to 250 MB, up to about 24 minutes. Big files
// are converted down (as low as 192 kbps) so they fit."
export function limitsSentence(mp3Bytes = MAX_MP3_UPLOAD_BYTES, wavBytes = MAX_WAV_UPLOAD_BYTES): string {
  return (
    `MP3 up to ${mibOf(mp3Bytes)} MB or WAV up to ${mibOf(wavBytes)} MB, up to about ${MAX_DURATION_MIN} minutes. ` +
    `Big files are converted down (as low as ${MIN_LADDER_BITRATE / 1000} kbps) so they fit.`
  )
}
