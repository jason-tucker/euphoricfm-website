import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Created per run by test/setup/global.ts (mkdtemp) and passed down in EFM_FX_DIR.
export function fxDir(): string {
  const d = process.env.EFM_FX_DIR
  if (!d) throw new Error('EFM_FX_DIR unset: fixtures are created by test/setup/global.ts')
  return d
}
export const fx = (name: string) => join(fxDir(), name)
export const fxBuf = (name: string) => readFileSync(fx(name))
