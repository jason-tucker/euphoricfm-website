// v0.4.0 SoundCloud-like media (what yt-dlp hands music-fetch for SoundCloud):
// AAC in fragmented MP4 (hls_aac_160k), Opus in Ogg (hls_opus_64k), MP3
// (http_mp3_128), plus hostile look-alikes. Made with ffmpeg (test image
// only), once per run, in the fixture dir. Nothing here touches a network.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fxDir } from './fixtures'

function ff(args: string[]) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
}

const noise = (d: number, r = 44100) => ['-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.3:duration=${d}:sample_rate=${r}`]
const FMP4 = ['-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof']

const MAKERS: Record<string, (out: string) => void> = {
  // SoundCloud's hls_aac_160k shape: fragmented MP4, AAC-LC 160 kbps, 44.1 kHz stereo
  'sc-aac-40s.m4a': (o) => ff([...noise(40), '-ac', '2', '-c:a', 'aac', '-b:a', '160k', ...FMP4, o]),
  'sc-aac-10m.m4a': (o) => ff([...noise(600), '-ac', '2', '-c:a', 'aac', '-b:a', '160k', ...FMP4, o]),
  'sc-aac-16m.m4a': (o) => ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=960:sample_rate=44100', '-ac', '2', '-c:a', 'aac', '-b:a', '96k', ...FMP4, o]),
  'sc-aac-25m.m4a': (o) => ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1500:sample_rate=22050', '-ac', '1', '-c:a', 'aac', '-b:a', '24k', ...FMP4, o]),
  'sc-aac-10s.m4a': (o) => ff([...noise(10), '-ac', '2', '-c:a', 'aac', '-b:a', '160k', ...FMP4, o]),
  // v0.4.1: what a Go+ track gives a logged-out client: a 30 s preview (AAC and MP3)
  'sc-aac-30s.m4a': (o) => ff([...noise(30), '-ac', '2', '-c:a', 'aac', '-b:a', '160k', ...FMP4, o]),
  'sc-mp3-30s.mp3': (o) => ff([...noise(30), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_id3v1', '0', o]),
  // v0.4.1: 860 s, just under the 320k limit (864 s), for the ladder's "longer of the two"
  'sc-aac-860s.m4a': (o) => ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=860:sample_rate=44100', '-ac', '2', '-c:a', 'aac', '-b:a', '96k', ...FMP4, o]),
  // hls_opus_64k: Opus in Ogg, 48 kHz
  'sc-opus-40s.opus': (o) => ff([...noise(40, 48000), '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', o]),
  // http_mp3_128
  'sc-mp3-40s.mp3': (o) => ff([...noise(40), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_id3v1', '0', o]),
  // refused: Vorbis in Ogg, MP3 inside MP4, AAC with a video stream
  'sc-vorbis-40s.ogg': (o) => ff([...noise(40), '-ac', '2', '-c:a', 'libvorbis', '-f', 'ogg', o]),
  'sc-mp3-in-mp4.m4a': (o) => ff([...noise(40), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', ...FMP4, o]),
  'sc-aac-video.mp4': (o) =>
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x64:d=40', ...noise(40), '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'aac', '-b:a', '128k', ...FMP4, o]),
  // artwork
  'sc-art.jpg': (o) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=500x500', '-frames:v', '1', '-q:v', '3', o]),
  'sc-art.png': (o) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=1200x1200', '-frames:v', '1', o]),
}

// Path of a generated fixture (made on first use).
export function scFx(name: string): string {
  const out = join(fxDir(), name)
  if (!existsSync(out)) {
    const make = MAKERS[name]
    if (!make) throw new Error(`no SoundCloud fixture ${name}`)
    make(out)
  }
  return out
}
export const scFxBuf = (name: string) => readFileSync(scFx(name))

export const HLS_PLAYLIST = Buffer.from('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:10\n#EXT-X-MAP:URI="http://mocks:4104/sc-egress/init.mp4"\n#EXTINF:10.0,\nhttp://mocks:4104/sc-egress/seg0.m4s\n#EXT-X-ENDLIST\n')
export const SVG_ART = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image href="http://mocks:4104/sc-svg-egress.png" width="10" height="10"/></svg>')

// A yt-dlp-shaped info JSON (the fields music-fetch reads).
export function scInfo(o: { title?: unknown; uploader?: unknown; duration?: number; genre?: string; license?: string; art?: string | null } = {}) {
  const art = o.art === undefined ? null : o.art
  return {
    id: '675426677',
    title: o.title ?? 'SC Title',
    uploader: o.uploader ?? 'SC Artist',
    duration: o.duration ?? 40,
    genre: o.genre ?? 'House',
    description: 'a description\nwith lines',
    license: o.license ?? 'cc-by',
    extractor: 'soundcloud',
    extractor_key: 'Soundcloud',
    _type: 'video',
    ...(art ? { thumbnails: [{ id: 't500x500', url: `https://i1.sndcdn.com/${art}` }], thumbnail: `https://i1.sndcdn.com/${art}` } : {}),
  }
}
