import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BASELINE, checkContract } from '@/server/azuracast/contract'

const spec = readFileSync(new URL('./fixtures/openapi-min.yml', import.meta.url), 'utf8')

describe('AzuraCast contract drift probe', () => {
  it('the fixture spec reproduces the P0d baseline hashes exactly', () => {
    // v0.3.6: + /files/rename (release of an Unreleased song, ' (n)' name)
    expect(Object.keys(BASELINE.paths)).toHaveLength(7)
    expect(BASELINE.paths['/station/{station_id}/files/rename']).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(BASELINE.requestBodies ?? {})).toEqual(['FlowFileUpload'])
    expect(checkContract(spec)).toEqual({ ok: true, drift: [] })
  })

  it('detects a changed path object', () => {
    const r = checkContract(spec.replace("summary: 'Upload a new file.'", "summary: 'Upload a new file!'"))
    expect(r.ok).toBe(false)
    expect(r.drift.map((d) => d.name)).toContain('path /station/{station_id}/files')
  })

  it('detects a changed referenced schema', () => {
    const changed = spec.replace("description: 'The destination path of the uploaded file.'\n          type: string", "description: 'The destination path of the uploaded file.'\n          type: integer")
    expect(changed).not.toBe(spec)
    const r = checkContract(changed)
    expect(r.ok).toBe(false)
    expect(r.drift.map((d) => d.name)).toEqual(expect.arrayContaining(['schemas bundle', 'schema Api_UploadFile']))
  })

  it('detects a change to the art upload body (multipart field)', () => {
    const r = checkContract(spec.replace("            properties:\n              file:", "            properties:\n              art:"))
    expect(r.drift.map((d) => d.name)).toContain('requestBody FlowFileUpload')
  })

  it('detects a change to the art GET the apply_art verify reads (same path object as the upload)', () => {
    const r = checkContract(spec.replace("summary: 'Returns the album art for a song, or a generic image.'", "summary: 'Returns the album art.'"))
    expect(r.drift.map((d) => d.name)).toContain('path /station/{station_id}/art/{media_id}')
  })

  it('detects a change to the rename route the release uses', () => {
    const r = checkContract(spec.replace("summary: 'Rename the specified files in the station media directory.'", "summary: 'Rename files.'"))
    expect(r.drift.map((d) => d.name)).toContain('path /station/{station_id}/files/rename')
  })

  it('detects a removed path', () => {
    const r = checkContract(spec.replace("  '/station/{station_id}/files/batch':", "  '/station/{station_id}/files/batch2':"))
    expect(r.drift).toContainEqual(expect.objectContaining({ name: 'path /station/{station_id}/files/batch', actual: null }))
  })
})
