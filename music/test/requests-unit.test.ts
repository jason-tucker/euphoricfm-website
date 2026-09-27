// P4 pure pieces: whitelist, proposed shape, main-artist rule, scan window,
// on-air matching, ticket card, admin setting schemas.
import { describe, expect, it } from 'vitest'
import { SETTING_SCHEMAS } from '@/server/admin/settings'
import { applyProposed, isRequestTarget, mainArtist, mainArtistChanged, ProposedSchema } from '@/server/requests/common'
import { requestCard } from '@/worker/requests/jobs'
import { afterScans, isOnAir, scanWindow } from '@/worker/ingest/window'

// 2026-09-27 12:MM:SS UTC
const at = (m: number, s: number) => Date.UTC(2026, 8, 27, 12, m, s)

describe('request target whitelist (Music/Artists/<folder>/<file> only)', () => {
  const refusedAnyRoot = [
    'ADS/ad.mp3',
    'Events/Friday/set.mp3',
    'UNRELEASED-2026/demo.mp3',
    'UNRELEASED/demo.mp3',
    'Removed/5001/song.mp3',
    'Music/song.mp3',
    'Music/Artists/song.mp3',
    'Music/Artists/A/../B/x.mp3',
    'Music/Artists/A/sub/x.mp3',
    '/Music/Artists/A/x.mp3',
    'Music/Artists/A/x\u0000.mp3',
  ]
  it('production root: only Music/Artists/<folder>/<file>; Portal-Test/ is refused', () => {
    expect(isRequestTarget('', 'Music/Artists/GRIM/luvusm.mp3')).toBe(true)
    expect(isRequestTarget('', 'Music/Artists/GRIM/kokoro_-_kokoro_-_touch.m4a')).toBe(true)
    for (const p of refusedAnyRoot) expect(isRequestTarget('', p), p).toBe(false)
    expect(isRequestTarget('', 'Portal-Test/Music/Artists/GRIM/x.mp3')).toBe(false)
    expect(isRequestTarget('', 'Portal-Test/x.mp3')).toBe(false)
  })
  it('prefix root: the same shape under Portal-Test/, and nothing outside it', () => {
    const R = 'Portal-Test/'
    expect(isRequestTarget(R, 'Portal-Test/Music/Artists/GRIM/luvusm.mp3')).toBe(true)
    expect(isRequestTarget(R, 'Music/Artists/GRIM/luvusm.mp3')).toBe(false)
    for (const p of refusedAnyRoot) expect(isRequestTarget(R, `Portal-Test/${p}`), p).toBe(false)
  })
})

describe('proposed edits', () => {
  it('accepts exactly {title?, artist?, album?, genre?}, trimmed', () => {
    expect(ProposedSchema.parse({ title: '  New  ' })).toEqual({ title: 'New' })
    for (const bad of [{}, { path: 'x' }, { title: 'a', playlists: [2] }, { title: '' }, { artist: '   ' }, { title: 'a\u0007' }, { genre: 'x'.repeat(256) }, { title: 5 }]) {
      expect(ProposedSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(ProposedSchema.safeParse({ album: '' }).success).toBe(true) // clearing an album is allowed
    expect(ProposedSchema.safeParse({ artId: '0f8fad5b-d9cb-469f-a165-70867728950e' }).success).toBe(true) // art alone
    expect(ProposedSchema.safeParse({ title: 'x', artId: 'a/b' }).success).toBe(false)
  })
  it('applies field by field over the current values', () => {
    const cur = { title: 'T', artist: 'A', album: 'B', genre: 'G' }
    expect(applyProposed(cur, { genre: 'Dance' })).toEqual({ ...cur, genre: 'Dance' })
  })
  it('only a change of MAIN artist counts (featured artists do not move files)', () => {
    expect(mainArtist('GRIM feat. KOKORO')).toBe('GRIM')
    expect(mainArtist('GRIM ft KOKORO')).toBe('GRIM')
    expect(mainArtistChanged('GRIM', 'grim feat. Someone')).toBe(false)
    expect(mainArtistChanged('GRIM', 'KOKORO')).toBe(true)
  })
})

// The window is the shared ingest/window.ts (P3 API) since the merge.
describe('scan window (clock-only; P0d-A offset 10 s → start ≥ :x1:30, end < :x5:30)', () => {
  const open = (t: number) => scanWindow(t, 10).open
  const waitS = (t: number) => scanWindow(t, 10).waitMs / 1000
  it('opens at :x1:30 and closes 30 s before the next scan', () => {
    expect(open(at(1, 29))).toBe(false)
    expect(open(at(1, 30))).toBe(true)
    expect(open(at(5, 29))).toBe(true)
    expect(open(at(5, 30))).toBe(false)
    expect(open(at(6, 10))).toBe(false)
  })
  it('reports the wait until the next opening', () => {
    expect(waitS(at(1, 5))).toBe(25)
    expect(waitS(at(5, 45))).toBe(45)
    expect(waitS(at(3, 0))).toBe(0)
  })
  it('re-verify runs after the next two scans', () => {
    expect(afterScans(at(3, 0), 2, 10)).toBe(at(11, 30))
  })
})

describe('now-playing match', () => {
  const media = { id: 1, unique_id: 'u', path: 'p', playlists: [], title: 'Luv U SM', artist: 'GRIM', song_id: 'abc' } as never
  it('matches by song id or text on the current or next song', () => {
    expect(isOnAir({ now_playing: { song: { id: 'abc' } } }, media)).toBe(true)
    expect(isOnAir({ now_playing: { song: { id: 'x' } }, playing_next: { song: { id: 'abc' } } }, media)).toBe(true)
    expect(isOnAir({ now_playing: { song: { id: 'x', text: 'grim - luv u sm' } } }, media)).toBe(true)
    expect(isOnAir({ now_playing: { song: { id: 'x', text: 'Other - Song' } }, playing_next: null }, media)).toBe(false)
    expect(isOnAir(null, media)).toBe(false)
  })
})

describe('request ticket card', () => {
  it('lists the current and proposed values, within the tickets limits', () => {
    const lines = requestCard({
      id: 7,
      kind: 'edit',
      mediaId: 5139,
      snapshot: { title: 'Luv U SM', artist: 'Grimm', album: 'Identity Shift', genre: 'Dance' },
      proposed: { artist: 'GRIM', genre: 'x'.repeat(300) },
      reason: 'typo in\nartist',
    } as never)
    expect(lines).toContain('Song: Grimm - Luv U SM')
    expect(lines).toContain('Artist: "Grimm" → "GRIM"')
    expect(lines).toContain('Reason: typo in artist')
    expect(lines.every((l) => l.length <= 200)).toBe(true)
    const art = requestCard({ id: 8, kind: 'edit', mediaId: 1, snapshot: { title: 't', artist: 'a' }, proposed: { artId: '0f8fad5b-d9cb-469f-a165-70867728950e' }, reason: null } as never)
    expect(art).toContain('New album art proposed')
  })
})

describe('admin setting schemas', () => {
  it('validate per key and never allow raising the plan caps', () => {
    expect(SETTING_SCHEMAS.assignable_playlist_ids!.safeParse([2, 15]).success).toBe(true)
    expect(SETTING_SCHEMAS.assignable_playlist_ids!.safeParse([2, 2]).success).toBe(false)
    expect(SETTING_SCHEMAS.assignable_playlist_ids!.safeParse(['new']).success).toBe(false)
    expect(SETTING_SCHEMAS.discord_invite_url!.safeParse('https://discord.gg/abc').success).toBe(true)
    expect(SETTING_SCHEMAS.discord_invite_url!.safeParse(null).success).toBe(true)
    expect(SETTING_SCHEMAS.discord_invite_url!.safeParse('https://evil.example/discord.gg/').success).toBe(false)
    expect(SETTING_SCHEMAS.playlist_names!.safeParse({ '2': '1General Rotation' }).success).toBe(true)
    expect(SETTING_SCHEMAS.playlist_names!.safeParse({ x: 'y' }).success).toBe(false)
    const caps = { maxUploadBytes: 35 * 1024 * 1024, chunkBytes: 8 * 1024 * 1024, maxInflightBytesPerUser: 1024 * 1024 * 1024, maxConcurrentUploadsPerUser: 3, maxStagingBytes: 5 * 1024 * 1024 * 1024, diskPausePercent: 85, maxItemsPerBatch: 20, ingestPerHour: 6, ingestSpacingS: 90 }
    expect(SETTING_SCHEMAS.caps!.safeParse(caps).success).toBe(true)
    expect(SETTING_SCHEMAS.caps!.safeParse({ ...caps, maxUploadBytes: 100 * 1024 * 1024 }).success).toBe(false)
    expect(SETTING_SCHEMAS.caps!.safeParse({ ...caps, ingestPerHour: 60 }).success).toBe(false)
    expect(SETTING_SCHEMAS.caps!.safeParse({ ...caps, extra: 1 }).success).toBe(false)
    expect(SETTING_SCHEMAS.rights_attestation!.safeParse({ version: '1', text: 'I own it' }).success).toBe(true)
    expect(SETTING_SCHEMAS.auto_close_days!.safeParse(0).success).toBe(false)
  })
})
