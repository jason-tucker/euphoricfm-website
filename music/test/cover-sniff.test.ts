// Cover type sniffing (pure; no ffmpeg). The SVG branch used to be one regex
// with an ambiguous `(<!--[\s\S]*?-->\s*)*` (CodeQL js/redos): a cover of
// ~24 empty comments not followed by <svg took ~0.3 s, and every 2 more
// comments ~4.5x longer, so a 1 KiB head of them hung the probe's event loop.
import { describe, expect, it } from 'vitest'
import { looksLikeSvg, sniffImage } from '@/probe/cover'

const svg = (s: string) => sniffImage(Buffer.from(s, 'utf8'))

describe('sniffImage: SVG prolog', () => {
  it.each([
    ['bare root', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['root closed by >', '<svg><rect/></svg>'],
    ['root followed by newline', '<svg\n  width="1">'],
    ['upper-case tokens', '<?XML version="1.0"?><!DOCTYPE SVG><SVG>'],
    ['BOM + leading whitespace', '﻿ \n\t<svg>'],
    [
      'full prolog',
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by x -->\n<!-- two -->\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg>',
    ],
    ['comments with no whitespace between', '<!--a--><!--b--><!---->'.repeat(3) + '<svg>'],
    ['comment containing < and >', '<!-- <svg> is not the root; x > y --><svg >'],
  ])('%s → svg', (_, s) => {
    expect(svg(s)).toBe('svg')
  })

  it.each([
    ['empty', ''],
    ['no root', '<?xml version="1.0"?>'],
    ['root-like prefix', '<svgx>'],
    ['root at end of head', '<svg'],
    ['html first', '<html><svg>'],
    ['unterminated declaration', '<?xml version="1.0" <svg'],
    ['unterminated comment', '<!-- <svg>'],
    ['unterminated doctype', '<!DOCTYPE svg <svg'],
    ['doctype for another root', '<!DOCTYPE html><svg>'],
    ['text before root', 'hello <svg>'],
    // A comment ends at its FIRST -->; the old regex could stretch it to a
    // later --> and accept text outside any comment before the root.
    ['text between comment end and a later -->', '<!-- a --> x --> <svg>'],
    ['declaration after a comment', '<!-- a --><?xml version="1.0"?><svg>'],
  ])('%s → not svg', (_, s) => {
    expect(svg(s)).toBeNull()
  })

  it('raster magic still wins over an svg-looking tail', () => {
    expect(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<svg>')]))).toBe('jpeg')
  })

  // Regression for js/redos: the old regex needs exponential time here
  // (measured 336 ms at 24 comments, ~4.5x per 2 more); the 1 KiB head holds
  // 146. The scan is linear, so even a 1 MB input is instant.
  it('a head full of comments that never reaches <svg is rejected in linear time', () => {
    const head = '<!---->'.repeat(146) + 'x'
    let t = performance.now()
    expect(sniffImage(Buffer.from(head))).toBeNull()
    expect(performance.now() - t).toBeLessThan(50)

    const big = '<!---->'.repeat(150_000) + 'x'
    t = performance.now()
    expect(looksLikeSvg(big)).toBe(false)
    expect(looksLikeSvg('<!---->'.repeat(150_000) + '<svg>')).toBe(true)
    expect(performance.now() - t).toBeLessThan(1000)

    t = performance.now()
    expect(looksLikeSvg('<!--' + '-'.repeat(1_000_000))).toBe(false)
    expect(looksLikeSvg('<?xml' + ' '.repeat(1_000_000))).toBe(false)
    expect(performance.now() - t).toBeLessThan(1000)
  })
})
