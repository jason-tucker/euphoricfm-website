import { describe, expect, it } from 'vitest'
import { playlistLabel, songName } from '@/components/format'
import { probeErrorText } from '@/components/messages'
import { changedFields, precheck } from '@/components/submit/types'
import { escapeLike, onLibrarySurface } from '@/server/ui/library'

const MB = 1024 * 1024

describe('library whitelist and LIKE escaping', () => {
  it('only Music/Artists/** is on the portal surface', () => {
    expect(onLibrarySurface('Music/Artists/GRIM/GRIM - Song.mp3')).toBe(true)
    expect(onLibrarySurface('UNRELEASED-DO NOT ADD TO ROTATION/x.mp3')).toBe(false)
    expect(onLibrarySurface('ADS/spot.mp3')).toBe(false)
    expect(onLibrarySurface('Events/x.mp3')).toBe(false)
    expect(onLibrarySurface('Removed/12/x.mp3')).toBe(false)
    expect(onLibrarySurface('Portal-Test/Music/Artists/A/b.mp3')).toBe(false)
    expect(onLibrarySurface('Music/Artists/../ADS/x.mp3')).toBe(false)
  })
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b')
  })
})

describe('advisory client pre-checks', () => {
  it('blocks empty and over-35 MB files, warns on non-MP3 names', () => {
    expect(precheck({ name: 'a.mp3', size: 0, type: '' }, 35 * MB).block).toBeTruthy()
    expect(precheck({ name: 'a.mp3', size: 36 * MB, type: 'audio/mpeg' }, 35 * MB).block).toMatch(/35 MB/)
    expect(precheck({ name: 'a.MP3', size: MB, type: '' }, 35 * MB)).toEqual({})
    expect(precheck({ name: 'a.wav', size: MB, type: 'audio/wav' }, 35 * MB).warn).toMatch(/MP3/)
    expect(precheck({ name: 'a.wav', size: MB, type: 'audio/wav' }, 35 * MB).block).toBeUndefined()
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
