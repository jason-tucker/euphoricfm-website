import { describe, expect, it } from 'vitest'
import { convertedLabel, playlistLabel, songName } from '@/components/format'
import { errorText, PROBE_ERROR_TEXT, probeErrorText } from '@/components/messages'
import { ACCEPT, changedFields, declaredType, fileKind, precheck } from '@/components/submit/types'
import { libraryArtUrl } from '@/server/ui/art'
import { escapeLike, folderOf, libraryRoot, onLibrarySurface } from '@/server/ui/library'

const MB = 1024 * 1024

describe('library whitelist and LIKE escaping', () => {
  it('production root: only Music/Artists/<folder>/<file> is on the portal surface', () => {
    expect(onLibrarySurface('Music/Artists/GRIM/GRIM - Song.mp3', '')).toBe(true)
    expect(onLibrarySurface('UNRELEASED-DO NOT ADD TO ROTATION/x.mp3', '')).toBe(false)
    expect(onLibrarySurface('ADS/spot.mp3', '')).toBe(false)
    expect(onLibrarySurface('Events/x.mp3', '')).toBe(false)
    expect(onLibrarySurface('Removed/12/x.mp3', '')).toBe(false)
    expect(onLibrarySurface('Portal-Test/Music/Artists/A/b.mp3', '')).toBe(false)
    expect(onLibrarySurface('Music/Artists/../ADS/x.mp3', '')).toBe(false)
    // exactly one artist folder deep (same rule as P4's isRequestTarget)
    expect(onLibrarySurface('Music/Artists/GRIM/Live/x.mp3', '')).toBe(false)
    expect(onLibrarySurface('Music/Artists/GRIM', '')).toBe(false)
  })
  it('honours PORTAL_TEST_PREFIX as the library root, and refuses a bad one', () => {
    const root = libraryRoot({ PORTAL_TEST_PREFIX: 'Portal-Test/' })
    expect(onLibrarySurface('Portal-Test/Music/Artists/A/b.mp3', root)).toBe(true)
    expect(onLibrarySurface('Music/Artists/A/b.mp3', root)).toBe(false)
    expect(folderOf('Portal-Test/Music/Artists/A B/c.mp3', root)).toBe('A B')
    expect(() => libraryRoot({ PORTAL_TEST_PREFIX: '../x/' })).toThrow()
    expect(libraryRoot({})).toBe('')
  })
  it('library art: only https://euphoric.fm URLs, else the unique_id fallback', () => {
    expect(libraryArtUrl('https://euphoric.fm/api/station/euphoricfm/art/abc123ef', null)).toBe('https://euphoric.fm/api/station/euphoricfm/art/abc123ef')
    expect(libraryArtUrl('https://evil.example/x.jpg', 'deadbeefdeadbeefdeadbeef')).toBe('https://euphoric.fm/api/station/euphoricfm/art/deadbeefdeadbeefdeadbeef')
    expect(libraryArtUrl(null, 'not hex!')).toBeNull()
  })
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b')
  })
})

describe('advisory client pre-checks', () => {
  const L = { mp3: 35 * MB, wav: 250 * MB }
  it('blocks empty and over-35 MB MP3s, warns on names that are neither MP3 nor WAV', () => {
    expect(precheck({ name: 'a.mp3', size: 0, type: '' }, L).block).toBeTruthy()
    expect(precheck({ name: 'a.mp3', size: 36 * MB, type: 'audio/mpeg' }, L).block).toMatch(/limit for MP3 files is 35 MB/)
    expect(precheck({ name: 'a.MP3', size: MB, type: '' }, L)).toEqual({})
    expect(precheck({ name: 'a.flac', size: MB, type: 'audio/flac' }, L).warn).toMatch(/MP3 or WAV/)
    // an unknown type gets the MP3 limit (the server caps an undeclared upload the same way)
    expect(precheck({ name: 'a.flac', size: 36 * MB, type: 'audio/flac' }, L).block).toMatch(/35 MB \(WAV files: 250 MB\)/)
  })
  it('WAV (v0.3.0): accepted by name or MIME type, with its own 250 MB limit', () => {
    expect(precheck({ name: 'a.wav', size: MB, type: 'audio/wav' }, L)).toEqual({})
    expect(precheck({ name: 'a.WAV', size: 200 * MB, type: '' }, L)).toEqual({})
    expect(precheck({ name: 'take', size: 100 * MB, type: 'audio/x-wav' }, L)).toEqual({})
    expect(precheck({ name: 'a.wav', size: 251 * MB, type: 'audio/wav' }, L).block).toMatch(/limit for WAV files is 250 MB/)
    // an admin-lowered WAV cap is what the page passes in
    expect(precheck({ name: 'a.wav', size: 101 * MB, type: 'audio/wav' }, { mp3: 35 * MB, wav: 100 * MB }).block).toMatch(/100 MB/)
  })
  it('declares the tus filetype the server caps by; the picker accepts WAV', () => {
    expect(declaredType({ name: 'a.wav', type: '' })).toBe('audio/wav')
    expect(declaredType({ name: 'x', type: 'audio/wave' })).toBe('audio/wav')
    expect(declaredType({ name: 'a.mp3', type: 'audio/mpeg' })).toBe('audio/mpeg')
    expect(declaredType({ name: 'a.flac', type: 'audio/flac' })).toBe('audio/mpeg')
    expect(fileKind({ name: 'a.mp3', type: '' })).toBe('mp3')
    for (const t of ['.mp3', '.wav', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave']) expect(ACCEPT.split(',')).toContain(t)
  })
  it('the converted-from-WAV label and the WAV rejection reasons are human text', () => {
    expect(convertedLabel('wav')).toBe('Converted from WAV (320 kbps MP3)')
    expect(convertedLabel('mp3')).toBeNull()
    expect(convertedLabel(null)).toBeNull()
    for (const code of [
      'wav_codec_unsupported', 'wav_rf64_unsupported', 'wav_truncated', 'wav_too_long', 'wav_too_large', 'mp3_too_large',
      'wav_bad_list', 'wav_bad_id3', 'wav_channels', 'wav_sample_rate', 'wav_header_mismatch', 'convert_timeout', 'convert_failed',
      'convert_invalid', 'converted_too_large', 'not_wav', 'wav_trailing_data', 'wav_chunk_too_large', 'wav_too_many_chunks',
      'wav_bad_fmt', 'wav_bad_data', 'wav_no_audio', 'wav_bad_riff', 'wav_bad_chunk', 'wav_not_single_stream', 'wav_unsupported',
    ]) {
      expect(PROBE_ERROR_TEXT[code], code).toBeTruthy()
    }
    expect(probeErrorText('wav_codec_unsupported')).toMatch(/ADPCM/)
    expect(probeErrorText('wav_too_long')).toMatch(/15 minutes/)
    expect(errorText('wav_upload_too_large')).toMatch(/250 MB/)
    expect(errorText('upload_too_large')).toMatch(/35 MB/)
  })
})

describe('per-field overrides', () => {
  it('only changed fields are sent; cleared fields become null', () => {
    const item = { title: 'T', artist: 'A', album: 'Al', genre: null } as never
    const e = { key: 'k', fileName: 'f', size: 1, phase: 'ready' as const, progress: 1, item, edits: { title: 'T', artist: 'A2', album: '', genre: 'House' } }
    expect(changedFields(e)).toEqual({ artist: 'A2', album: null, genre: 'House' })
  })
})

describe('formatting', () => {
  it('names playlists from settings, else by id', () => {
    expect(playlistLabel({ '2': '1General Rotation' }, 2)).toBe('1General Rotation (#2)')
    expect(playlistLabel({}, 9)).toBe('Playlist #9')
  })
  it('song names and probe errors are readable', () => {
    expect(songName({ title: 'T', artist: 'A' })).toBe('A – T')
    expect(songName({ title: null, artist: null })).toBe('Untitled')
    expect(probeErrorText('bitrate_too_low')).toMatch(/128 kbps/)
    expect(probeErrorText('weird')).toMatch(/weird/)
  })
})
