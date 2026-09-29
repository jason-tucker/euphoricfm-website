// A copy of `data` (an MP3 whose first frame carries a Xing / Info header
// with the frames and bytes fields, as ffmpeg's mp3 muxer writes it) whose
// header claims `seconds` at 44.1 kHz, 1152 samples per frame. The byte count
// stays true, so ffprobe trusts the lie: its -show_format duration becomes
// `seconds`. Shared by the upload probe (fit-probe) and probe_fetch tests.
export function forgeXingFrames(data: Buffer, seconds: number): Buffer {
  const b = Buffer.from(data)
  const at = [b.indexOf('Xing', 0, 'latin1'), b.indexOf('Info', 0, 'latin1')].filter((i) => i >= 0 && i < 64)[0]
  if (at === undefined) throw new Error('no Xing / Info header')
  if ((b.readUInt32BE(at + 4) & 0x03) !== 0x03) throw new Error('Xing header without the frames and bytes fields')
  b.write('Xing', at, 'latin1')
  b.writeUInt32BE(Math.round((seconds * 44100) / 1152), at + 8)
  return b
}
