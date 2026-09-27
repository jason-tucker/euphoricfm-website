// Generates audio / hostile fixtures with ffmpeg (test image only), and under
// REQUIRE_ALL waits for the running stack.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { apicV3, frameV3, tag, textV3, zlibBombFrame } from '../helpers/id3'

const DIR = '/tmp/efm-fixtures'

function ff(args: string[]) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
}

function rawMp3(name: string, seconds: number, kbps: number, freq = 440) {
  ff(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-ac', '2', '-ar', '44100', '-b:a', `${kbps}k`, '-id3v2_version', '0', '-write_xing', '0', join(DIR, name)])
}

// v0.3.0 WAV inputs: real encoder output (ffmpeg's wav muxer writes
// WAVE_FORMAT_EXTENSIBLE for >2 channels, >16 bits or >48 kHz) plus the
// compressed codecs the probe must refuse. Crafted structures (lying sizes,
// id3 chunks, hostile LIST/INFO) are built in the tests (helpers/wav.ts).
function wavFixtures() {
  const tone = (d: number, r: number) => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${d}:sample_rate=${r}`]
  const meta = ['-metadata', 'title=Wav Title', '-metadata', 'artist=Wav Artist', '-metadata', 'album=Wav Album', '-metadata', 'genre=House', '-metadata', 'date=2024']
  const w = (name: string, args: string[]) => ff([...args, '-f', 'wav', join(DIR, name)])
  w('s16-44k-stereo.wav', [...tone(35, 44100), ...meta, '-ac', '2', '-c:a', 'pcm_s16le'])
  w('s24-48k-stereo.wav', [...tone(35, 48000), '-ac', '2', '-c:a', 'pcm_s24le'])
  w('s24-96k-stereo.wav', [...tone(35, 96000), '-ac', '2', '-c:a', 'pcm_s24le'])
  w('s16-88k-stereo.wav', [...tone(35, 88200), '-ac', '2', '-c:a', 'pcm_s16le'])
  w('s16-22k-mono.wav', [...tone(35, 22050), '-ac', '1', '-c:a', 'pcm_s16le'])
  w('s32-44k-stereo.wav', [...tone(35, 44100), '-ac', '2', '-c:a', 'pcm_s32le'])
  w('u8-44k-mono.wav', [...tone(35, 44100), '-ac', '1', '-c:a', 'pcm_u8'])
  w('f32-48k-stereo.wav', [...tone(35, 48000), '-ac', '2', '-c:a', 'pcm_f32le'])
  w('f64-44k-stereo.wav', [...tone(35, 44100), '-ac', '2', '-c:a', 'pcm_f64le'])
  w('s16-48k-5.1.wav', [...tone(35, 48000), '-af', 'pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0', '-c:a', 'pcm_s16le'])
  w('adpcm.wav', [...tone(35, 44100), '-ac', '2', '-c:a', 'adpcm_ms'])
  w('mp3-in.wav', [...tone(35, 44100), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k'])
  w('alaw.wav', [...tone(35, 44100), '-ac', '1', '-c:a', 'pcm_alaw'])
  w('short.wav', [...tone(10, 44100), '-ac', '2', '-c:a', 'pcm_s16le'])
  ff([...tone(35, 44100), '-ac', '2', '-c:a', 'pcm_s16le', '-rf64', 'always', '-f', 'wav', join(DIR, 'rf64.wav')])
  // > 35 MB: 4 min 10 s of 16-bit 44.1 kHz stereo (~44 MB), with INFO tags
  w('big-44mb.wav', ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.2:duration=250:sample_rate=44100', ...meta, '-ac', '2', '-c:a', 'pcm_s16le'])
  // an MP3 over 35 MB: a real MP3 followed by padding (the magic check passes)
  const mp3 = readFileSync(join(DIR, 'raw35.mp3'))
  writeFileSync(join(DIR, 'big-36mb.mp3'), Buffer.concat([mp3, Buffer.alloc(36 * 1024 * 1024 - mp3.length + 1024)]))
  writeFileSync(join(DIR, '.done-wav'), '')
}

export default async function setup() {
  if (!existsSync(join(DIR, '.done'))) {
    mkdirSync(DIR, { recursive: true })
    rawMp3('raw35.mp3', 35, 128)
    rawMp3('raw35b.mp3', 35, 128, 660)
    rawMp3('raw35c.mp3', 35, 128, 880)
    rawMp3('lowbr.mp3', 35, 64)
    rawMp3('short.mp3', 10, 128)
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=1200x900', '-frames:v', '1', join(DIR, 'cover.png')])
    const raw = readFileSync(join(DIR, 'raw35.mp3'))
    const png = readFileSync(join(DIR, 'cover.png'))
    const basic = [frameV3('TIT2', textV3('Test Title')), frameV3('TPE1', textV3('Test Artist')), frameV3('TALB', textV3('Test Album')), frameV3('TCON', textV3('Pop'))]
    writeFileSync(join(DIR, 'tagged-png.mp3'), Buffer.concat([tag(3, [...basic, frameV3('APIC', apicV3('image/png', png))]), raw]))
    writeFileSync(join(DIR, 'tagged-png-b.mp3'), Buffer.concat([tag(3, [...basic, frameV3('APIC', apicV3('image/png', png))]), readFileSync(join(DIR, 'raw35b.mp3'))]))
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="48">' +
        '<script>alert(document.cookie)</script><rect width="64" height="48" fill="#feb139"/>' +
        '<image href="http://mocks:4104/svg-egress.png" width="10" height="10"/></svg>',
    )
    writeFileSync(join(DIR, 'svg-cover.mp3'), Buffer.concat([tag(3, [...basic, frameV3('APIC', apicV3('image/svg+xml', svg))]), readFileSync(join(DIR, 'raw35c.mp3'))]))
    // 6 MB APIC → tag > 5 MB
    writeFileSync(join(DIR, 'huge-apic.mp3'), Buffer.concat([tag(3, [frameV3('APIC', apicV3('image/png', Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)])))]), raw]))
    // 64 MB of zeros deflated into one compressed ID3v2.4 frame
    writeFileSync(join(DIR, 'zlib-bomb.mp3'), Buffer.concat([tag(4, [zlibBombFrame(64 * 1024 * 1024)]), raw]))
    // PNG header claiming 60000x60000 (decompression-bomb dimensions)
    const bombPng = Buffer.from(png)
    bombPng.writeUInt32BE(60000, 16)
    bombPng.writeUInt32BE(60000, 20)
    writeFileSync(join(DIR, 'dimbomb-cover.mp3'), Buffer.concat([tag(3, [...basic, frameV3('APIC', apicV3('image/png', bombPng))]), raw]))
    const m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nhttp://mocks:4104/hls-egress/seg0.ts\n#EXT-X-ENDLIST\n'
    writeFileSync(join(DIR, 'hls.mp3'), Buffer.from(m3u8))
    writeFileSync(join(DIR, 'hls-id3.mp3'), Buffer.concat([tag(3, [frameV3('TIT2', textV3('x'))]), Buffer.from(m3u8)]))
    // a single valid-looking MPEG frame header in front of the playlist
    writeFileSync(join(DIR, 'hls-fakeframe.mp3'), Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.from(m3u8)]))
    writeFileSync(join(DIR, 'html.mp3'), Buffer.from('<html><script>alert(1)</script></html>'))
    // album-art fixtures (standalone uploads)
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1600x1200', '-frames:v', '1', join(DIR, 'art.png')])
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=800x800', '-frames:v', '1', '-q:v', '3', join(DIR, 'art.jpg')])
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x480', '-frames:v', '1', '-c:v', 'libwebp', join(DIR, 'art.webp')])
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x64', '-frames:v', '1', join(DIR, 'art.gif')])
    writeFileSync(join(DIR, '.done-art'), '')
    writeFileSync(join(DIR, '.done'), '')
  }
  if (!existsSync(join(DIR, '.done-wav'))) wavFixtures()

  if (process.env.REQUIRE_ALL === '1' && process.env.E2E_WEB_URL) {
    const deadline = Date.now() + 120_000
    for (;;) {
      try {
        const r = await fetch(`${process.env.E2E_WEB_URL}/api/health`)
        const m = await fetch(`${process.env.MOCKS_CONTROL}/__mock/az/calls`)
        if (r.ok && m.ok) break
      } catch {}
      if (Date.now() > deadline) throw new Error('stack not ready')
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
