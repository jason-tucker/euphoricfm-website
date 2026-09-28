import { describe, expect, it } from 'vitest'
import {
  archiveDirPath,
  assertArtistFileSource,
  assertArtistMoveTarget,
  assertExistingFolder,
  assertIngestPath,
  assertRestore,
  assertLegacySource,
  assertSafePath,
  buildIngestPath,
  ingestFileName,
  isLibrarySurface,
  newArtistFolder,
  PathError,
  releaseFileName,
  resolveIngestPath,
  sanitizeComponent,
} from '@/server/paths/builder'

const ROOTS = ['', 'Portal-Test/'] as const

describe('path builder: sanitisation (plan §3.5)', () => {
  it('keeps the allowlist and NFC-normalises', () => {
    expect(sanitizeComponent('Beyoncé')).toBe('Beyoncé')
    expect(sanitizeComponent('Beyoncé')).toBe('Beyoncé') // NFD → NFC
    expect(sanitizeComponent("Guns N' Roses (Live) & Friends!")).toBe("Guns N' Roses (Live) & Friends!")
    expect(sanitizeComponent('a   b\t\tc')).toBe('a b c')
  })

  it('replaces separators, control and bidi characters', () => {
    expect(sanitizeComponent('AC/DC')).toBe('AC DC')
    expect(sanitizeComponent('a\\b')).toBe('a b')
    expect(sanitizeComponent('evil‮gnp.mp3')).toBe('evil gnp.mp3')
    expect(sanitizeComponent('nul\u0000byte')).toBe('nul byte')
    expect(sanitizeComponent('line\nbreak')).toBe('line break')
    expect(sanitizeComponent('．．／etc')).toBe('etc') // fullwidth ../ is not in the allowlist
  })

  it('strips leading dots and refuses empty results', () => {
    expect(sanitizeComponent('...hidden')).toBe('hidden')
    expect(() => sanitizeComponent('..')).toThrow(PathError)
    expect(() => sanitizeComponent('.')).toThrow(PathError)
    expect(() => sanitizeComponent('   ')).toThrow(PathError)
    expect(() => sanitizeComponent('///')).toThrow(PathError)
  })

  it('caps components at 150 bytes on a code-point boundary', () => {
    const s = sanitizeComponent('é'.repeat(200))
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(150)
    expect(s).toBe('é'.repeat(75))
  })

  it('builds <Artist> - <Title>.mp3 with collision suffixes', () => {
    expect(ingestFileName('GRIM', 'Luv U SM')).toBe('GRIM - Luv U SM.mp3')
    expect(ingestFileName('GRIM', 'Luv U SM', 2)).toBe('GRIM - Luv U SM (2).mp3')
    expect(() => ingestFileName('a', 'b', 10)).toThrow(PathError)
    const long = ingestFileName('A'.repeat(140), 'B'.repeat(140), 9)
    expect(Buffer.byteLength(long.replace(/\.mp3$/, ''))).toBeLessThanOrEqual(150)
    expect(long.endsWith(' (9).mp3')).toBe(true)
  })
})

describe('path builder: traversal attempts never leave the artist folder', () => {
  const titles = ['../../etc/passwd', '..', '../..', '..\\..\\x', '%2e%2e%2f', '/absolute', 'a/../../b', '‥/․', 'x\u0000../y']
  for (const root of ROOTS) {
    for (const t of titles) {
      it(`[${root || 'prod'}] title ${JSON.stringify(t)}`, () => {
        let p: string
        try {
          p = buildIngestPath(root, 'GRIM', ingestFileName('GRIM', t))
        } catch (e) {
          expect(e).toBeInstanceOf(PathError) // refused is also fine
          return
        }
        expect(p.startsWith(`${root}Music/Artists/GRIM/`)).toBe(true)
        expect(p.split('/')).toHaveLength(root ? 5 : 4)
        expect(p.split('/').some((s) => s === '..' || s === '.')).toBe(false)
      })
    }
  }

  it('new artist folders are sanitised too', () => {
    expect(newArtistFolder('../Removed')).toBe('Removed')
    expect(newArtistFolder('A/B')).toBe('A B')
    expect(() => newArtistFolder('..')).toThrow(PathError)
  })

  it('existing folders are verbatim but structurally checked', () => {
    expect(assertExistingFolder('Aaron "Spirit" Michaels')).toBe('Aaron "Spirit" Michaels')
    for (const bad of ['..', '.', '.hidden', 'a/b', 'a\\b', 'a\u0000b', 'a\u0007b', '']) {
      expect(() => assertExistingFolder(bad), bad).toThrow(PathError)
    }
  })
})

describe('path builder: destination and source assertions', () => {
  it('ingest pattern is anchored to the root', () => {
    expect(assertIngestPath('', 'Music/Artists/GRIM/x.mp3')).toBe('Music/Artists/GRIM/x.mp3')
    for (const bad of ['Music/Artists/GRIM/x.m4a', 'Music/Artists/x.mp3', 'Music/Artists/GRIM/sub/x.mp3', 'ADS/x.mp3', 'Music/Artists/../ADS/x.mp3', 'Portal-Test/Music/Artists/GRIM/x.mp3']) {
      expect(() => assertIngestPath('', bad), bad).toThrow(PathError)
    }
    expect(() => assertIngestPath('Portal-Test/', 'Music/Artists/GRIM/x.mp3')).toThrow(PathError)
    expect(assertIngestPath('Portal-Test/', 'Portal-Test/Music/Artists/GRIM/x.mp3')).toBeTruthy()
  })

  it('refuses bad roots', () => {
    for (const bad of ['Music/', '../', '/', 'Portal-Test', 'Portal-Test/../', 'Removed/']) {
      expect(() => assertIngestPath(bad, `${bad}Music/Artists/a/b.mp3`), bad).toThrow(PathError)
    }
  })

  it('generic structure checks', () => {
    for (const bad of ['', '/Music/x', 'Music//x', 'Music/./x', 'Music/../x', 'a\\b', 'http://x/y', 'Music/x\u0000', 'Music/é']) {
      expect(() => assertSafePath(bad), JSON.stringify(bad)).toThrow(PathError)
    }
  })

  it('archive, artist move and restore', () => {
    expect(archiveDirPath('', 1103)).toBe('Removed/1103')
    expect(() => archiveDirPath('', 0)).toThrow(PathError)
    expect(assertArtistFileSource('', 'Music/Artists/GRIM/kokoro_-_kokoro_-_touch.m4a')).toBeTruthy() // m4a allowed as a SOURCE
    expect(() => assertArtistFileSource('', 'UNRELEASED-DO NOT ADD TO ROTATION/x.mp3')).toThrow(PathError)
    expect(() => assertArtistFileSource('', 'Removed/5/x.mp3')).toThrow(PathError)
    const active = new Set(['GRIM'])
    expect(assertArtistMoveTarget('', 'Music/Artists/GRIM', active)).toBe('Music/Artists/GRIM')
    expect(() => assertArtistMoveTarget('', 'Music/Artists/Nobody', active)).toThrow(PathError)
    expect(() => assertArtistMoveTarget('', 'Music/Artists/GRIM/sub', active)).toThrow(PathError)
    const rec = { archivedPath: 'Removed/7/x.m4a', originalPath: 'Music/Artists/GRIM/x.m4a' }
    expect(assertRestore('', 'Removed/7/x.m4a', 'Music/Artists/GRIM/x.m4a', rec)).toBeTruthy()
    expect(() => assertRestore('', 'Removed/8/x.m4a', 'Music/Artists/GRIM/x.m4a', rec)).toThrow('restore_source_mismatch')
    expect(() => assertRestore('', 'Removed/7/x.m4a', 'ADS/x.m4a', rec)).toThrow('restore_target_mismatch')
  })

  it('library surface is Music/Artists/** only', () => {
    expect(isLibrarySurface('', 'Music/Artists/GRIM/luvusm.mp3')).toBe(true)
    for (const p of ['ADS/Paid/x.mp3', 'Events/x.mp3', 'UNRELEASED-DO NOT ADD TO ROTATION/x.mp3', 'Removed/1/x.mp3', 'Music/Holidays/x.mp3', 'Music/Artists/../ADS/x.mp3', 'Portal-Test/Music/Artists/a/b.mp3']) {
      expect(isLibrarySurface('', p), p).toBe(false)
    }
  })
})

describe('path builder: collision resolution (P0d-B: any entry at the exact path is taken)', () => {
  it('walks (2)…(9) and fails after nine', async () => {
    const taken = new Set(['Music/Artists/GRIM/GRIM - Song.mp3', 'Music/Artists/GRIM/GRIM - Song (2).mp3'])
    const seen: string[] = []
    const p = await resolveIngestPath('', 'GRIM', 'GRIM', 'Song', async (dir, path) => {
      seen.push(dir)
      return taken.has(path)
    })
    expect(p).toBe('Music/Artists/GRIM/GRIM - Song (3).mp3')
    expect(seen.every((d) => d === 'Music/Artists/GRIM')).toBe(true)
    await expect(resolveIngestPath('', 'GRIM', 'GRIM', 'Song', async () => true)).rejects.toThrow('collision_exhausted')
  })
})

describe('segment hardening (review minor 3)', () => {
  it('refuses dot/space-only segments, edge whitespace and any \\p{C} code point', () => {
    for (const bad of ['Music/Artists/../x.mp3', 'Music/Artists/.. /x.mp3', 'Music/Artists/ ../x.mp3', 'Music/Artists/.../x.mp3', 'Music/Artists/ /x.mp3', 'Music/Artists/A /x.mp3', 'Music/Artists/ A/x.mp3', 'Music/Artists/A/x.mp3 ', 'Music/Artists/A\uE000/x.mp3', 'Music/Artists/A\uFFFE/x.mp3', 'Music/Artists/A\u200B/x.mp3']) {
      expect(() => assertSafePath(bad), JSON.stringify(bad)).toThrow(PathError)
    }
    expect(() => assertSafePath('Music/Artists/Mr. T./Mr. T. - Song.mp3')).not.toThrow()
    for (const bad of ['Foo ', ' Foo', '...', '. .']) expect(() => assertExistingFolder(bad), bad).toThrow(PathError)
  })
})

describe('v0.3.3 legacy UNRELEASED import: the one extra source, and release names', () => {
  it('the legacy source is exactly the UNRELEASED folder (≤3 levels below), .mp3 or .m4a, under the root', () => {
    for (const root of ROOTS) {
      for (const p of ['kokoro_-_aodhi_-_something.m4a', 'save_me_from_me.mp3', 'Music/KOKORO/kokoro_-_kokoro_-_rage.m4a', 'kokoro_-_ishii石井_-_cute.m4a']) {
        expect(assertLegacySource(root, `${root}UNRELEASED-DO NOT ADD TO ROTATION/${p}`)).toBeTruthy()
      }
      for (const p of [
        `${root}UNRELEASED-DO NOT ADD TO ROTATION/x.flac`,
        `${root}UNRELEASED-DO NOT ADD TO ROTATION/x.wav`,
        `${root}UNRELEASED-DO NOT ADD TO ROTATION/a/b/c/d/x.mp3`,
        `${root}UNRELEASED-DO NOT ADD TO ROTATION/../Music/Artists/A/x.mp3`,
        `${root}UNRELEASED-2026/x.mp3`,
        `${root}UNRELEASED/x.mp3`,
        `${root}Music/Artists/A/x.mp3`,
        `${root}Removed/5/x.mp3`,
        `${root}Events/UNRELEASED-DO NOT ADD TO ROTATION/x.mp3`,
      ]) {
        expect(() => assertLegacySource(root, p), p).toThrow(PathError)
      }
    }
    // prefix profile: a production path is never a legacy source, and vice versa
    expect(() => assertLegacySource('Portal-Test/', 'UNRELEASED-DO NOT ADD TO ROTATION/x.mp3')).toThrow(PathError)
    expect(() => assertLegacySource('', 'Portal-Test/UNRELEASED-DO NOT ADD TO ROTATION/x.mp3')).toThrow(PathError)
    // it is still NOT a request / archive / move source for anything else
    expect(() => assertArtistFileSource('', 'UNRELEASED-DO NOT ADD TO ROTATION/x.m4a')).toThrow(PathError)
    expect(isLibrarySurface('', 'UNRELEASED-DO NOT ADD TO ROTATION/x.m4a')).toBe(false)
  })

  it('release keeps the name, else " (n)" before the extension, n ≤ 9', () => {
    expect(releaseFileName('kokoro_-_sophie_-_home.m4a', 1)).toBe('kokoro_-_sophie_-_home.m4a')
    expect(releaseFileName('kokoro_-_sophie_-_home.m4a', 2)).toBe('kokoro_-_sophie_-_home (2).m4a')
    expect(releaseFileName('save_me_from_me.mp3', 9)).toBe('save_me_from_me (9).mp3')
    expect(releaseFileName('b.a.b.y.m4a', 3)).toBe('b.a.b.y (3).m4a')
    expect(() => releaseFileName('x.mp3', 10)).toThrow('bad_collision_index')
    expect(() => releaseFileName('x.mp3', 0)).toThrow('bad_collision_index')
  })
})
