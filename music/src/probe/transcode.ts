// MP3 → MP3 re-encode (v0.3.2). An uploaded MP3 whose audio does not fit the
// final-file cap (src/lib/fit.ts) is DECODED here and encoded again as a CBR
// MP3 at the highest ladder rate that fits. This is the first time the probe
// decodes an untrusted MP3's audio (before, MP3 audio was only demuxed by
// ffprobe and stream-copied by finalize), so the run is held to the WAV
// conversion's sandbox and more:
//   * only after the magic-byte gate (MPEG Layer III, no free format), the
//     ID3v2 pre-scan (≤5 MB, no compressed / encrypted frames) and ffprobe -f
//     mp3 (exactly one mp3 audio stream, anything else only an attached
//     picture, duration ≤ MAX_DURATION_S) have accepted the file;
//   * forced demuxer (-f mp3) AND forced decoder (-c:a mp3float) as input
//     options, so no probing picks another demuxer / codec;
//   * file/pipe protocols only, one thread, no stdin;
//   * -vn -sn -dn as INPUT options (the demuxer discards every non-audio
//     stream, e.g. the APIC picture, which is never decoded), -map 0:a:0,
//     no metadata / chapters copied, no ID3 written (finalize writes tags);
//   * the rate is picked from the COUNTED duration (probe.ts
//     countedDurationS: the frames the demuxer reads, not the upload's own
//     Xing header, which may lie), and -t caps the output at the duration
//     limit (+5 s) and -fs at the audio budget (+1 byte), so neither the
//     decode nor what it writes to /staging/work can run past what could
//     ever be accepted;
//   * run through runLimited with the WAV conversion's limits (wav.ts
//     CONVERT_VMEM_KB / CONVERT_TIMEOUT_S / CONVERT_NICE): prlimit (address
//     space, no core), timeout, nice 19, its own process group, argv only,
//     no shell.

import { AUDIO_BUDGET_BYTES, MAX_DURATION_S } from '../lib/fit'

// 44.1 / 48 kHz are kept; every other MPEG rate (32 kHz, and the MPEG-2 /
// 2.5 rates 24 / 22.05 / 16 / 12 / 11.025 / 8 kHz) goes to 44.1 kHz.
export function mp3TargetRate(sampleRate: number): number {
  return sampleRate === 44100 || sampleRate === 48000 ? sampleRate : 44100
}

export function mp3TranscodeArgs(input: string, output: string, src: { sampleRate: number; channels: number }, bitrate: number): string[] {
  if (!Number.isInteger(bitrate) || bitrate < 8000 || bitrate > 320_000 || bitrate % 1000 !== 0) throw new Error('mp3TranscodeArgs: bad bitrate')
  const rate = mp3TargetRate(src.sampleRate)
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-protocol_whitelist', 'file,pipe',
    '-threads', '1',
    '-filter_threads', '1',
    '-vn', '-sn', '-dn',
    '-c:a', 'mp3float',
    '-f', 'mp3', '-i', `file:${input}`,
    '-map', '0:a:0',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-vn', '-sn', '-dn',
    ...(src.channels > 2 ? ['-ac', '2'] : []),
    ...(rate !== src.sampleRate ? ['-ar', String(rate)] : []),
    '-t', String(MAX_DURATION_S + 5),
    '-fs', String(AUDIO_BUDGET_BYTES + 1),
    '-c:a', 'libmp3lame',
    '-b:a', `${bitrate / 1000}k`,
    '-threads', '1',
    '-id3v2_version', '0',
    '-write_id3v1', '0',
    '-f', 'mp3',
    `file:${output}`,
  ]
}
