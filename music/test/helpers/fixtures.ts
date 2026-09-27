import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const FX_DIR = '/tmp/efm-fixtures'
export const fx = (name: string) => join(FX_DIR, name)
export const fxBuf = (name: string) => readFileSync(fx(name))
