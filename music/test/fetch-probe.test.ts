// v0.4.0 probe_fetch: what music-fetch downloaded from SoundCloud, converted in
// the probe (in-process in the test image: the same ffmpeg / prlimit as the
// probe image). The e2e suite repeats the flow through the real containers.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { AUDIO_BUDGET_BYTES, pickBitrate } from '@/lib/fit'
import { fetchedFfprobeArgs, fetchedTranscodeArgs, runProbeFetch, sniffFetched, withJobDir } from '@/probe/fetched'
import { copyNoFollowHashed } from '@/probe/files'
import { processOne, recoverInterrupted } from '@/probe/main'
import { probeFetchRequest, readSpoolResult, writeSpoolRequest, type ProbeFetchRequest } from '@/server/spool/protocol'
import { fxBuf } from './helpers/fixtures'
import { HLS_PLAYLIST, scFx, scFxBuf, SVG_ART } from './helpers/soundcloud'
import { forgeXingFrames } from './helpers/xing'

let root: string
let dirs: { fetch: string; uploads: string; work: string }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

// Stage bytes the way music-fetch leaves them: /staging/fetch/<uuid>/audio.<ext> (+ artwork.raw).
function stage(audio: Buffer, ext: ProbeFetchRequest['ext'], art?: Buffer) {
  const fetchId = randomUUID()
  mkdirSync(join(dirs.fetch, fetchId))
  writeFileSync(join(dirs.fetch, fetchId, `audio.${ext}`), audio)
  if (art) writeFileSync(join(dirs.fetch, fetchId, 'artwork.raw'), art)
  return fetchId
}

function request(fetchId: string, audio: Buffer, ext: ProbeFetchRequest['ext'], o: Partial<ProbeFetchRequest> = {}): ProbeFetchRequest {
  const format = ({ m4a: 'mp4', mp4: 'mp4', opus: 'ogg', ogg: 'ogg', oga: 'ogg', mp3: 'mp3' } as const)[ext]
  return probeFetchRequest.parse({
    v: 1,
    id: fetchId,
    type: 'probe_fetch',
    fetchId,
    upload: randomUUID().replace(/-/g, ''),
    ext,
    format,
    sha256: sha(audio),
    size: audio.length,
    artworkSha256: null,
    declaredDurationS: 40,
    ...o,
  })
}

async function convert(name: string, ext: ProbeFetchRequest['ext'], o: Partial<ProbeFetchRequest> = {}, art?: Buffer) {
  const audio = scFxBuf(name)
  const fetchId = stage(audio, ext, art)
  const req = request(fetchId, audio, ext, { ...(art ? { artworkSha256: sha(art) } : {}), ...o })
  return { req, r: await runProbeFetch(req, dirs) }
}

function ffprobe(file: string) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString()) as {
    format: { format_name: string; duration: string }
    streams: { codec_type: string; codec_name: string; bit_rate?: string; sample_rate?: string; channels?: number }[]
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'probe-fetch-'))
  dirs = { fetch: join(root, 'fetch'), uploads: join(root, 'uploads'), work: join(root, 'work') }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
})

describe('probe_fetch: the formats yt-dlp returns for SoundCloud', () => {
  it('AAC in fragmented MP4 (hls_aac_160k) → CBR 320k MP3 published under the upload id; artwork → JPEG ≤1000 px', async () => {
    const art = scFxBuf('sc-art.png') // 1200 px PNG → scaled down
    const { req, r } = await convert('sc-aac-40s.m4a', 'm4a', {}, art)
    expect(r).toMatchObject({ ok: true, type: 'probe_fetch', source: 'in-worker', inputFormat: 'aac', transcodeKbps: 320, bitrate: 320000 })
    if (!r.ok || r.type !== 'probe_fetch') throw new Error(JSON.stringify(r))
    const mp3 = join(dirs.uploads, req.upload)
    const bytes = readFileSync(mp3)
    expect(sha(bytes)).toBe(r.sha256)
    expect(r.size).toBe(bytes.length)
    expect(bytes.length).toBeLessThanOrEqual(AUDIO_BUDGET_BYTES)
    const j = ffprobe(mp3)
    expect(j.format.format_name).toBe('mp3')
    expect(j.streams).toEqual([expect.objectContaining({ codec_type: 'audio', codec_name: 'mp3', bit_rate: '320000', sample_rate: '44100', channels: 2 })])
    expect(Math.abs(r.durationS - 40)).toBeLessThan(2)
    expect(r.cover).toMatchObject({ file: `cover-${req.id}.jpg`, width: 1000, height: 1000 })
    const jpg = readFileSync(join(dirs.uploads, r.cover!.file))
    expect(jpg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(r.flags).toContain('converted_from_aac')
    // the raw download is never touched (the probe mounts it read-only)
    expect(existsSync(join(dirs.fetch, req.fetchId, 'audio.m4a'))).toBe(true)
    // no work dir is left behind
    expect(readdirSync(dirs.work)).toEqual([])
  })

  it('Opus in Ogg (hls_opus_64k) → CBR 320k MP3 at 48 kHz', async () => {
    const { req, r } = await convert('sc-opus-40s.opus', 'opus')
    expect(r).toMatchObject({ ok: true, inputFormat: 'opus', transcodeKbps: 320 })
    const j = ffprobe(join(dirs.uploads, req.upload))
    expect(j.streams[0]).toMatchObject({ codec_name: 'mp3', sample_rate: '48000', bit_rate: '320000' })
  })

  it('an MP3 (http_mp3_128) that fits is kept byte for byte (no re-encode)', async () => {
    const { req, r } = await convert('sc-mp3-40s.mp3', 'mp3')
    expect(r).toMatchObject({ ok: true, inputFormat: 'mp3', bitrate: 128000, cover: null })
    if (!r.ok || r.type !== 'probe_fetch') throw new Error()
    expect(r.transcodeKbps).toBeUndefined()
    expect(r.sha256).toBe(req.sha256)
    expect(readFileSync(join(dirs.uploads, req.upload)).equals(scFxBuf('sc-mp3-40s.mp3'))).toBe(true)
    expect(r.flags).toEqual(['kept_untouched'])
  })

  // v0.4.1: the two durations must agree within max(2 s, 2 %) (below), so
  // "the longer" only matters at a ladder boundary.
  it('the fit ladder: the rate comes from the LONGER of the file and SoundCloud’s own duration (860 s file, 870 s declared → 256k)', async () => {
    expect(pickBitrate(860)).toBe(320_000) // the file alone would get 320k
    const { r } = await convert('sc-aac-860s.m4a', 'm4a', { declaredDurationS: 870 }) // 320k fits 864 s at most
    expect(r).toMatchObject({ ok: true, transcodeKbps: 256, bitrate: 256000 })
  }, 300_000)
})

// Second pass A2 (CONFIRMED major): a Go+ / premium track gives a logged-out
// client only a 30 s preview while SoundCloud's metadata says the full
// length. music-fetch refuses the previews it recognises (preview_only); the
// probe compares the audio's own length with SoundCloud's as well.
describe('probe_fetch: the audio must be as long as SoundCloud says (sc_duration_mismatch, v0.4.1)', () => {
  const run = async (name: string, ext: ProbeFetchRequest['ext'], declaredDurationS: number, audio: Buffer = scFxBuf(name)) => {
    const fetchId = stage(audio, ext)
    const req = request(fetchId, audio, ext, { declaredDurationS })
    const r = await runProbeFetch(req, dirs)
    return { req, r }
  }

  it('a 30 s preview of a 4-min track (AAC, declaredDurationS 240) → sc_duration_mismatch, nothing published', async () => {
    const { req, r } = await run('sc-aac-30s.m4a', 'm4a', 240)
    // (before: ok, a 30 s "Converted from AAC" MP3 pending under the real title)
    expect(r).toMatchObject({ ok: false, error: 'sc_duration_mismatch' })
    expect(existsSync(join(dirs.uploads, req.upload))).toBe(false)
  })

  it('the same for an MP3 preview (http_mp3_128), which would otherwise be kept byte for byte', async () => {
    const { req, r } = await run('sc-mp3-30s.mp3', 'mp3', 240)
    expect(r).toMatchObject({ ok: false, error: 'sc_duration_mismatch' })
    expect(existsSync(join(dirs.uploads, req.upload))).toBe(false)
  })

  it('reported before the 30 s floor: a 10 s clip of a 4-min track is a mismatch, not too_short', async () => {
    expect((await run('sc-aac-10s.m4a', 'm4a', 240)).r).toMatchObject({ ok: false, error: 'sc_duration_mismatch' })
  })

  it('tolerance max(2 s, 2 %): 40 s declared 41.5 passes, 43 does not; a missing (0) declared duration never passes', async () => {
    expect((await run('sc-aac-40s.m4a', 'm4a', 41.5)).r).toMatchObject({ ok: true })
    expect((await run('sc-aac-40s.m4a', 'm4a', 43)).r).toMatchObject({ ok: false, error: 'sc_duration_mismatch' })
    expect((await run('sc-aac-40s.m4a', 'm4a', 0)).r).toMatchObject({ ok: false, error: 'sc_duration_mismatch' })
    expect((await run('sc-mp3-40s.mp3', 'mp3', 38.5)).r).toMatchObject({ ok: true })
    expect((await run('sc-mp3-40s.mp3', 'mp3', 37)).r).toMatchObject({ ok: false, error: 'sc_duration_mismatch' })
  })

  it('an MP3 kept byte for byte is judged by its counted frames, not its Xing header (26 min claiming 10 min)', async () => {
    const forged = forgeXingFrames(fxBuf('fit-26m-128k.mp3'), 600)
    // SoundCloud's duration agrees with the lie: the counted 26 min still disagree
    expect((await run('forged.mp3', 'mp3', 600, forged)).r).toMatchObject({ ok: false, error: 'sc_duration_mismatch' })
    // and agrees with the truth: over the 24-min cap
    expect((await run('forged.mp3', 'mp3', 1560, forged)).r).toMatchObject({ ok: false, error: 'too_long' })
  }, 120_000)
})

describe('probe_fetch: refusals', () => {
  const refused = async (audio: Buffer, ext: ProbeFetchRequest['ext'], o: Partial<ProbeFetchRequest> = {}) => {
    const fetchId = stage(audio, ext)
    const req = request(fetchId, audio, ext, o)
    const r = await runProbeFetch(req, dirs)
    expect(existsSync(join(dirs.uploads, req.upload))).toBe(false)
    expect(existsSync(join(dirs.uploads, `cover-${req.id}.jpg`))).toBe(false)
    return r
  }

  it('the bytes must be the ones music-fetch reported (sha256, size)', async () => {
    const a = scFxBuf('sc-aac-40s.m4a')
    expect(await refused(a, 'm4a', { sha256: 'f'.repeat(64) })).toMatchObject({ ok: false, error: 'sc_hash_mismatch' })
    expect(await refused(a, 'm4a', { size: a.length + 1 })).toMatchObject({ ok: false, error: 'input_size_mismatch' })
  })

  it('an HLS playlist, HTML, or bytes of another container never reach a demuxer they could steer', async () => {
    expect(await refused(HLS_PLAYLIST, 'm4a')).toMatchObject({ ok: false, error: 'sc_format_mismatch' })
    expect(await refused(Buffer.from('<!doctype html><script>alert(1)</script>'), 'mp3')).toMatchObject({ ok: false })
    // Ogg bytes named .m4a; MP4 bytes named .opus
    expect(await refused(scFxBuf('sc-opus-40s.opus'), 'm4a')).toMatchObject({ ok: false, error: 'sc_format_mismatch' })
    expect(await refused(scFxBuf('sc-aac-40s.m4a'), 'opus')).toMatchObject({ ok: false, error: 'sc_format_mismatch' })
    // an extension / format pair that disagrees in the request itself
    expect(await refused(scFxBuf('sc-aac-40s.m4a'), 'm4a', { format: 'ogg' })).toMatchObject({ ok: false, error: 'sc_format_mismatch' })
  })

  it('only AAC in MP4, Opus in Ogg and MP3 are decoded (Vorbis, MP3-in-MP4, a video stream are refused)', async () => {
    expect(await refused(scFxBuf('sc-vorbis-40s.ogg'), 'ogg')).toMatchObject({ ok: false, error: 'sc_format_mismatch' })
    expect(await refused(scFxBuf('sc-mp3-in-mp4.m4a'), 'm4a')).toMatchObject({ ok: false, error: 'sc_codec_unsupported' })
    expect(await refused(scFxBuf('sc-aac-video.mp4'), 'mp4')).toMatchObject({ ok: false, error: 'sc_unexpected_streams' })
  })

  it('30 s to 24 min, from the decoded stream', async () => {
    expect(await refused(scFxBuf('sc-aac-10s.m4a'), 'm4a', { declaredDurationS: 10 })).toMatchObject({ ok: false, error: 'too_short' })
    expect(await refused(scFxBuf('sc-aac-25m.m4a'), 'm4a', { declaredDurationS: 1500 })).toMatchObject({ ok: false, error: 'too_long' })
  })

  it('a symlinked download is not followed', async () => {
    const fetchId = randomUUID()
    mkdirSync(join(dirs.fetch, fetchId))
    const target = join(root, 'decoy.m4a')
    writeFileSync(target, scFxBuf('sc-aac-40s.m4a'))
    symlinkSync(target, join(dirs.fetch, fetchId, 'audio.m4a'))
    const r = await runProbeFetch(request(fetchId, scFxBuf('sc-aac-40s.m4a'), 'm4a'), dirs)
    expect(r).toMatchObject({ ok: false, error: 'input_missing' })
    // a job DIRECTORY that is a link (to somewhere else the probe can read) is refused too
    const other = randomUUID()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'audio.m4a'), scFxBuf('sc-aac-40s.m4a'))
    symlinkSync(elsewhere, join(dirs.fetch, other))
    expect(await runProbeFetch(request(other, scFxBuf('sc-aac-40s.m4a'), 'm4a'), dirs)).toMatchObject({ ok: false, error: 'input_missing' })
  })

  it('SC-SEC-2: a job dir swapped for a symlink AFTER the check cannot redirect the read', async () => {
    // music-fetch (compromised) renames the checked dir away and plants a link
    // to another dir the probe can read, between the check and the open.
    const real = scFxBuf('sc-aac-40s.m4a')
    const fetchId = stage(real, 'm4a')
    const elsewhere = join(root, `swap-${fetchId}`)
    mkdirSync(elsewhere)
    const decoy = Buffer.concat([real, Buffer.from('decoy')])
    writeFileSync(join(elsewhere, 'audio.m4a'), decoy)
    const out = join(root, `swap-copy-${fetchId}`)
    const r = await withJobDir(dirs, fetchId, async (dir) => {
      renameSync(join(dirs.fetch, fetchId), join(dirs.fetch, `${fetchId}-moved`))
      symlinkSync(elsewhere, join(dirs.fetch, fetchId))
      return copyNoFollowHashed(join(dir, 'audio.m4a'), out, 64 * 1024 * 1024)
    })
    // the bytes of the directory that was checked, never the decoy's
    expect(r).toEqual({ sha256: sha(real), size: real.length })
    expect(readFileSync(out).equals(real)).toBe(true)
  })
})

describe('probe_fetch: artwork takes the album-art path; a bad one is dropped, never fatal', () => {
  it('SVG (could reference the network), a hash mismatch, and garbage are dropped with a flag', async () => {
    const svg = await convert('sc-aac-40s.m4a', 'm4a', {}, SVG_ART)
    expect(svg.r).toMatchObject({ ok: true, cover: null, flags: expect.arrayContaining(['cover_type']) })
    const bad = await convert('sc-aac-40s.m4a', 'm4a', { artworkSha256: 'a'.repeat(64) }, scFxBuf('sc-art.jpg'))
    expect(bad.r).toMatchObject({ ok: true, cover: null, flags: expect.arrayContaining(['cover_hash_mismatch']) })
    const junk = await convert('sc-aac-40s.m4a', 'm4a', {}, Buffer.from('not an image at all'))
    expect(junk.r).toMatchObject({ ok: true, cover: null, flags: expect.arrayContaining(['cover_type']) })
    const jpg = await convert('sc-aac-40s.m4a', 'm4a', {}, scFxBuf('sc-art.jpg'))
    expect(jpg.r).toMatchObject({ ok: true, cover: { width: 500, height: 500 } })
  })
})

describe('probe_fetch: argv and inbox rules', () => {
  it('forced demuxer and decoder, file protocol only (never pipe), no external MP4 data references', () => {
    const p = fetchedFfprobeArgs('/w/in.m4a', 'mp4')
    expect(p).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-enable_drefs', '0', '-f', 'mp4', '-threads', '1']))
    expect(p.join(' ')).not.toContain('pipe')
    const t = fetchedTranscodeArgs('/w/in.m4a', '/w/out.mp3', 'mp4', { sampleRate: 44100, channels: 2 }, 256000)
    const i = t.indexOf('-i')
    expect(t.slice(0, i)).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-enable_drefs', '0', '-c:a', 'aac', '-f', 'mp4', '-vn', '-sn', '-dn']))
    expect(t).toEqual(expect.arrayContaining(['-c:a', 'libmp3lame', '-b:a', '256k', '-map', '0:a:0', '-map_metadata', '-1', '-id3v2_version', '0']))
    expect(t.join(' ')).not.toContain('pipe')
    const o = fetchedTranscodeArgs('/w/in.ogg', '/w/out.mp3', 'ogg', { sampleRate: 48000, channels: 6 }, 320000)
    expect(o.slice(0, o.indexOf('-i'))).toEqual(expect.arrayContaining(['-c:a', 'opus', '-f', 'ogg']))
    expect(o).toEqual(expect.arrayContaining(['-ac', '2']))
    expect(o).not.toContain('-enable_drefs')
  })

  it('sniffs containers by magic bytes', () => {
    expect(sniffFetched(scFxBuf('sc-aac-40s.m4a').subarray(0, 64))).toBe('mp4')
    expect(sniffFetched(scFxBuf('sc-opus-40s.opus').subarray(0, 64))).toBe('ogg')
    expect(sniffFetched(scFxBuf('sc-vorbis-40s.ogg').subarray(0, 64))).toBeNull()
    expect(sniffFetched(scFxBuf('sc-mp3-40s.mp3').subarray(0, 64))).toBe('mp3')
    expect(sniffFetched(HLS_PLAYLIST)).toBeNull()
  })

  it('a probe_fetch request is accepted only from in-worker; an interrupted one is answered and its output removed', async () => {
    const spool = join(root, 'spool')
    for (const d of ['in-web', 'in-worker', 'out', 'claimed']) mkdirSync(join(spool, d), { recursive: true })
    const audio = scFxBuf('sc-aac-40s.m4a')
    const fetchId = stage(audio, 'm4a')
    const req = request(fetchId, audio, 'm4a')
    await writeSpoolRequest(join(spool, 'in-web'), req)
    const all = { spool, uploads: dirs.uploads, work: dirs.work, final: join(root, 'final'), artIn: join(root, 'art-in'), art: join(root, 'art'), fetch: dirs.fetch, mmChild: '' }
    await processOne('in-web', req.id, all)
    expect(await readSpoolResult(join(spool, 'out'), req.id)).toMatchObject({ ok: false, error: 'type_not_allowed_in_inbox', source: 'in-web' })
    expect(existsSync(join(dirs.uploads, req.upload))).toBe(false)

    // A probe_fetch claimed but never answered (the probe restarted mid-job):
    // whatever it published is removed and the worker gets 'interrupted'.
    const lost = request(stage(audio, 'm4a'), audio, 'm4a')
    writeFileSync(join(spool, 'claimed', `in-worker-${lost.id}.json`), JSON.stringify(lost))
    writeFileSync(join(dirs.uploads, lost.upload), 'half-published mp3')
    writeFileSync(join(dirs.uploads, `cover-${lost.id}.jpg`), 'half-published cover')
    await recoverInterrupted({ spool, uploads: dirs.uploads })
    expect(await readSpoolResult(join(spool, 'out'), lost.id)).toMatchObject({ source: 'in-worker', type: 'probe_fetch', ok: false, error: 'interrupted' })
    expect(existsSync(join(dirs.uploads, lost.upload))).toBe(false)
    expect(existsSync(join(dirs.uploads, `cover-${lost.id}.jpg`))).toBe(false)
  })

  it('a repeated request (worker restart) never deletes what an earlier run published', async () => {
    const audio = scFxBuf('sc-aac-40s.m4a')
    const fetchId = stage(audio, 'm4a')
    const req = request(fetchId, audio, 'm4a')
    expect(await runProbeFetch(req, dirs)).toMatchObject({ ok: true })
    const first = readFileSync(join(dirs.uploads, req.upload))
    // the raw download is gone by the second run (released): it fails, and
    // the MP3 of the first run stays
    const { rmSync } = await import('node:fs')
    rmSync(join(dirs.fetch, fetchId), { recursive: true })
    expect(await runProbeFetch(req, dirs)).toMatchObject({ ok: false, error: 'input_missing' })
    expect(readFileSync(join(dirs.uploads, req.upload)).equals(first)).toBe(true)
  })
})
