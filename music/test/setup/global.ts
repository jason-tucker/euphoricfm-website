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
