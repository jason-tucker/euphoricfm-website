// v0.5.2: native dropdowns were unreadable — the open option list rendered
// white text on a white background (Chrome/Windows falls back to a white
// popup under .input's translucent fill while options inherit cream text).
// jsdom cannot render the popup, so this pins the CSS that prevents it and
// that every <select> gets it.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const globals = readFileSync('src/app/globals.css', 'utf8')
const events = readFileSync('src/events/components/events.css', 'utf8')

function block(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`)
  expect(i, `${selector} rule`).toBeGreaterThanOrEqual(0)
  return css.slice(i, css.indexOf('}', i))
}
const opaque = (decl: string) => /background-color:\s*(#[0-9a-f]{6}\b|rgb\(\d+ \d+ \d+\))/i.test(decl)

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith('.tsx') ? [p] : []
  })
}

describe('dropdowns are readable (no white-on-white option list)', () => {
  it('select.input: opaque dark fill, appearance none + a CSS-only chevron, focus ring, disabled state', () => {
    const b = block(globals, 'select.input')
    expect(opaque(b)).toBe(true)
    expect(b).toMatch(/appearance-none/)
    expect(b).toMatch(/color-scheme:\s*dark/)
    expect(b).toMatch(/background-image:\s*linear-gradient/)
    expect(b).not.toMatch(/url\(/)
    expect(block(globals, 'select.input:focus-visible')).toMatch(/outline:\s*2px solid/)
    expect(block(globals, 'select.input:disabled')).toMatch(/cursor-not-allowed opacity-50/)
    expect(globals).toMatch(/@media \(max-width: 640px\) \{\s*select\.input \{\s*min-height: 48px;/)
  })

  it('options and optgroups get the same opaque dark background with cream text; html and select stay color-scheme dark', () => {
    const o = block(globals, 'select option,\n  select optgroup')
    expect(opaque(o)).toBe(true)
    expect(o).toMatch(/color:\s*rgb\(var\(--efm-cream-rgb\)\)/)
    expect(block(globals, 'select')).toMatch(/color-scheme:\s*dark/)
    expect(block(globals, 'html')).toMatch(/color-scheme:\s*dark/)
    // the fill of the closed select and of the list are the same colour
    const fill = (s: string) => /background-color:\s*(#[0-9a-f]{6})/i.exec(s)![1]
    expect(fill(o)).toBe(fill(block(globals, 'select.input')))
  })

  it('the events stylesheet no longer brings back the native (auto) appearance', () => {
    expect(block(events, '.ev-select')).not.toMatch(/appearance/)
  })

  it('every <select> in the portals carries the .input class', () => {
    const offenders: string[] = []
    for (const f of [...tsxFiles('src/app'), ...tsxFiles('src/components'), ...tsxFiles('src/events/components')]) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<select\b[^>]*>/g)) if (!/className="[^"]*\binput\b/.test(m[0])) offenders.push(`${f}: ${m[0].slice(0, 80)}`)
    }
    expect(offenders).toEqual([])
  })
})
