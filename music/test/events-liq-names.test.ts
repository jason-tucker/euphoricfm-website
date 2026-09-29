// Every playlist name the events build can send to AzuraCast must come out of
// AzuraCast's name → Liquidsoap variable pipeline as a valid identifier.
//
// Regression for the 2026-09-29 station-14 outage (live test 2): the helper
// playlist "~EVT1 s1" became `playlist_~evt1_s1` in the regenerated .liq
// (rawurlencode leaves '~' alone), Liquidsoap refused the config with
// "Error 2: Parse error" and station_14_backend went FATAL.
//
// test/helpers/azuracast-liq.ts is a port of AzuraCast's
// Strings::getProgrammaticString + Station::generateShortName +
// ConfigWriter::cleanUpVarName; the golden cases below pin it to what the
// real station 14 answered (short_name in test/fixtures/azuracast-real/).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile } from '@/events/azuracast/compiler'
import { isMainName, PlaylistBody } from '@/events/azuracast/allowlist'
import { annName, mainName, pinName, sanitizePlaylistName } from '@/events/contract/paths'
import { MAIN_NAME_MAX, PRIVATE_PLAYLIST_NAME } from '@/events/contract/rules'
import { azuracastLiqVarName, cleanUpVarName, getProgrammaticString, isLiquidsoapSafePlaylistName, LIQUIDSOAP_IDENT_RE, playlistShortName, type LiqPortOptions } from './helpers/azuracast-liq'

const VARIANTS: [string, LiqPortOptions][] = [
  ['unicode \\w (mb_ereg, UTF-8)', {}],
  ['ASCII \\w', { asciiWord: true }],
]

function expectSafe(name: string) {
  for (const [label, opts] of VARIANTS) {
    const v = azuracastLiqVarName(name, opts)
    if (!LIQUIDSOAP_IDENT_RE.test(v)) expect.fail(`${JSON.stringify(name)} → ${JSON.stringify(v)} is not a Liquidsoap identifier (${label})`)
  }
}

// Deterministic PRNG (mulberry32): the "random" corpus is the same every run.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Titles a member (or staff) might type, hostile ones included.
const TITLE_CORPUS: string[] = [
  'Grand Opening',
  "Jake's Grand Opening!",
  '~EVT1 s1',
  '~~~ hidden ~~~',
  'Car Meet ~ Night',
  '~',
  'a..b...c',
  '...',
  '"quoted" & \'single\'',
  '<b>bold</b> <script>alert(1)</script>',
  '&amp; &lt;tag&gt; &#126; &tilde; &#x7e;',
  'Café Noël — Ünïcödé',
  'Ｆｕｌｌ ｗｉｄｔｈ ～ tilde',
  '日本語のイベント',
  'Ελληνικά Σ ς',
  'Straße ß ẞ',
  'İstanbul DİSKO',
  'עברית ‏rtl‎',
  'emoji 🎉🔥💃 party',
  '😀',
  'tab\there\nnewline\r\nend',
  'nbsp space em　ideographic',
  'zero​width‍joiner﻿bom',
  'bidi ‮evil‬',
  'control \u0000\u0007\u001b',
  'back\\slash/slash:colon*star?q|pipe',
  '100%',
  '1234',
  '1e5',
  '-1.5',
  '(parens) [brackets] {braces}',
  'semi;colon,comma',
  'a-b_c.d',
  'x'.repeat(200),
  '¼ ½ ¾ ² ³ ¹ × ÷ ± § ¶ ©®™',
  'Æsir Œuvre Ðenver Þorn',
  '∀∂∃∅∇∈ ≤≥≠ ←→ ♠♣♥♦',
  '·•…‰′″',
  ' leading and trailing ',
  'EVT1 s1',
  'evt12 a3',
  'EVT1-s1',
]

function randomTitles(n: number, seed: number): string[] {
  const pool = [
    ...'abcXYZ019 ',
    ...'~~..""\'\'&;<>/\\|:*?#%+-_=,()[]{}!@$^`',
    'é', 'ß', 'ẞ', 'Ω', 'Σ', 'ς', 'ﬁ', 'Ⅷ', '½', '²', '日', 'ア', '한', 'ع', '́', '​', '‍', ' ', ' ', '　', '‮', '\t', '\n', '\u0000',
    '🎉', '👨‍👩‍👧', '🇺🇸', '～', '＃', '＆', '．',
  ]
  const r = rng(seed)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(r() * 40)
    let s = ''
    for (let j = 0; j < len; j++) s += pool[Math.floor(r() * pool.length)]
    out.push(s)
  }
  return out
}

describe('AzuraCast name → Liquidsoap variable (port)', () => {
  it('matches the short names station 14 really answered', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/azuracast-real/st14_playlists.json'), 'utf8')) as { name: string; short_name: string }[]
    expect(fixture.length).toBeGreaterThan(3)
    for (const p of fixture) expect(playlistShortName(p.name), p.name).toBe(p.short_name)
    // and the station-1 names seen in file memberships
    expect(getProgrammaticString('1General Rotation')).toBe('1general_rotation')
  })

  it('reproduces the incident: "~EVT1 s1" becomes `playlist_~evt1_s1`, which is NOT a Liquidsoap identifier', () => {
    for (const [, opts] of VARIANTS) {
      expect(azuracastLiqVarName('~EVT1 s1', opts)).toBe('playlist_~evt1_s1')
      expect(azuracastLiqVarName('~EVT1 a1', opts)).toBe('playlist_~evt1_a1')
      expect(isLiquidsoapSafePlaylistName('~EVT1 s1', opts)).toBe(false)
    }
    // the check itself fails on it (proves this suite would have caught the outage)
    expect(() => expectSafe('~EVT1 s1')).toThrow(/not a Liquidsoap identifier/)
    // the names that were fine that day
    expect(azuracastLiqVarName('Private event')).toBe('playlist_private_event')
    expect(azuracastLiqVarName('Fasion Show (Test)')).toBe('playlist_fasion_show_28test29')
  })

  it('ports the pieces faithfully (entities, rawurlencode, numeric short names)', () => {
    expect(cleanUpVarName('playlist_café')).toBe('playlist_cafe')
    expect(cleanUpVarName('playlist_日')).toBe('playlist_E697A5')
    expect(cleanUpVarName('playlist_©')).toBe('playlist_c') // &copy; → its first letter
    expect(cleanUpVarName('playlist_½')).toBe('playlist_26frac123B') // &frac12; has a digit: kept, then encoded
    expect(cleanUpVarName('playlist_²')).toBe('playlist_26sup23B')
    expect(cleanUpVarName('playlist_a-b.c')).toBe('playlist_a_b_c')
    expect(cleanUpVarName('playlist_x,y;z')).toBe('playlist_x2Cy3Bz')
    expect(cleanUpVarName('playlist_~')).toBe('playlist_~')
    expect(playlistShortName('1234')).toBe('station_1234')
    expect(getProgrammaticString('a..b...c')).toBe('a.b.c')
    // PHP 8.3 mb_ereg's \w does not keep the join controls (verifier re-run)
    expect(getProgrammaticString('a\u200db\u200cc')).toBe('abc')
    expect(getProgrammaticString('Ünï 🎉 x')).toBe('ünï__x')
    expect(getProgrammaticString('Ünï 🎉 x', { asciiWord: true })).toBe('n__x')
  })
})

describe('every name the events build can emit is Liquidsoap-safe', () => {
  it('helper names: pins and announcements for every event id 1..99999 and every n 1..200', () => {
    let checked = 0
    for (let id = 1; id <= 99_999; id++) {
      const n = 1 + (id % 200)
      for (const name of [pinName(id, n), annName(id, n), pinName(id, 200), annName(id, 1)]) {
        const v = azuracastLiqVarName(name)
        if (!LIQUIDSOAP_IDENT_RE.test(v)) expect.fail(`${name} → ${v}`)
        checked++
      }
    }
    for (let n = 1; n <= 200; n++) {
      for (const id of [1, 9, 10, 42, 99, 100, 999, 1000, 9999, 10_000, 54_321, 99_999]) {
        expectSafe(pinName(id, n))
        expectSafe(annName(id, n))
        checked += 2
      }
    }
    // the exact variable (the helper name maps character for character)
    expect(azuracastLiqVarName(pinName(1, 1))).toBe('playlist_evt1_s1')
    expect(azuracastLiqVarName(annName(99_999, 200))).toBe('playlist_evt99999_a200')
    expect(checked).toBeGreaterThan(400_000)
  })

  it('helper names are ASCII, never carry "~", and are valid playlist bodies', () => {
    for (const name of [pinName(1, 1), annName(1, 1), pinName(99_999, 200), annName(123, 45)]) {
      expect(name).toMatch(/^EVT[1-9]\d* [sa][1-9]\d*$/)
      expect(name.includes('~')).toBe(false)
    }
  })

  it('main names: sanitised titles from a hostile corpus (unicode, emoji, punctuation, "~", "..", quotes, HTML) and 5000 random ones', () => {
    const titles = [...TITLE_CORPUS, ...randomTitles(5000, 20260929)]
    let nonTrivial = 0
    for (const title of titles) {
      for (const visibility of ['public', 'private'] as const) {
        const name = mainName({ visibility, title })
        expect(isMainName(name) || name === PRIVATE_PLAYLIST_NAME, JSON.stringify(title)).toBe(true)
        expect(name.includes('~')).toBe(false)
        expectSafe(name)
        if (visibility === 'public' && name !== 'Event') nonTrivial++
      }
      expectSafe(sanitizePlaylistName(title) || 'Event')
    }
    expect(nonTrivial).toBeGreaterThan(1000)
  })

  it('any name the wrapper accepts as a main name is safe (random names over the whole allowed charset)', () => {
    const allowed = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,\'!?&()-:#+', 'é', 'Ω', 'ß', '日', 'Ⅷ', '٣', 'ǅ']
    const r = rng(7)
    let accepted = 0
    for (let i = 0; i < 20_000; i++) {
      const len = 1 + Math.floor(r() * MAIN_NAME_MAX)
      let s = ''
      for (let j = 0; j < len; j++) s += allowed[Math.floor(r() * allowed.length)]
      if (!isMainName(s)) continue
      accepted++
      expectSafe(s)
    }
    expect(accepted).toBeGreaterThan(5000)
  })

  it('the compiler emits only safe names, and a "~" name can never reach a playlist body', () => {
    const plan = compile({
      event: { id: 1, version: 1, startsAt: new Date('2026-10-10T20:00:00-04:00'), endsAt: new Date('2026-10-10T22:00:00-04:00'), mainName: mainName({ visibility: 'public', title: '~Grand ~ Opening..' }), playlistOrder: 'shuffle' },
      tracks: [
        { position: 1, mediaId: 501, pinAt: null },
        { position: 2, mediaId: 502, pinAt: new Date('2026-10-10T21:00:00-04:00') },
        { position: 3, mediaId: 503, pinAt: new Date('2026-10-10T21:30:00-04:00') },
      ],
      announcements: [{ mediaId: 601, durationS: 30, mode: 'at', at: new Date('2026-10-10T20:30:00-04:00'), everyMin: null, from: null, until: null }],
      settings: { maxRows: 500, pinStrategy: 'split_main', announceStrategy: 'interrupt_rows' },
      now: new Date('2026-10-01T12:00:00Z'),
    })
    expect(plan.playlists.map((p) => p.name)).toEqual(['Grand Opening..', 'EVT1 s1', 'EVT1 s2', 'EVT1 a1'])
    for (const p of plan.playlists) expectSafe(p.name)
    // an injected legacy name generator is refused by the body check
    expect(() =>
      compile({
        event: { id: 1, version: 1, startsAt: new Date('2026-10-10T20:00:00-04:00'), endsAt: new Date('2026-10-10T22:00:00-04:00'), mainName: 'Grand Opening', playlistOrder: 'shuffle' },
        tracks: [
          { position: 1, mediaId: 501, pinAt: null },
          { position: 2, mediaId: 502, pinAt: new Date('2026-10-10T21:00:00-04:00') },
        ],
        announcements: [],
        settings: { maxRows: 500, pinStrategy: 'split_main', announceStrategy: 'interrupt_rows' },
        now: new Date('2026-10-01T12:00:00Z'),
        names: { pin: (id, n) => `~EVT${id} s${n}`, ann: (id, n) => `~EVT${id} a${n}` },
      }),
    ).toThrow(/invalid_body/)
    const body = { ...plan.playlists[1]!.body, name: '~EVT1 s1' }
    expect(PlaylistBody.safeParse(body).success).toBe(false)
    expect(PlaylistBody.safeParse({ ...body, name: 'Grand ~ Opening' }).success).toBe(false)
  })
})
