// v0.3.0 WAV uploads in the submit UI: the picker accepts WAV, each file is
// pre-checked against its own type's limit, the tus upload DECLARES its type
// (the server caps by it), and a converted item says so.
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PROBE_ERROR_TEXT } from '@/components/messages'
import { FileCard } from '@/components/submit/FileCard'
import { SubmitFlow } from '@/components/submit/SubmitFlow'
import type { Entry } from '@/components/submit/types'
import { stubFetch } from './fetch'

const MB = 1024 * 1024
const tusUploads: { file: File; opts: { metadata?: Record<string, string>; endpoint?: string } }[] = []

vi.mock('tus-js-client', () => ({
  Upload: class {
    url = null
    constructor(file: File, opts: { metadata?: Record<string, string> }) {
      tusUploads.push({ file, opts })
    }
    findPreviousUploads() {
      return Promise.resolve([])
    }
    start() {}
    abort() {
      return Promise.resolve()
    }
  },
}))

function sized(name: string, type: string, size: number): File {
  const f = new File([new Uint8Array(16)], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

const noop = () => {}
const card = (e: Partial<Entry>) => (
  <FileCard
    entry={{ key: 'k', fileName: 'song.wav', size: 40 * MB, phase: 'ready', progress: 1, itemId: 7, edits: { title: 'T', artist: 'A', album: '', genre: '' }, ...e } as Entry}
    inBatchDuplicate={false}
    onEdit={noop}
    onRemove={noop}
    onPause={noop}
    onResume={noop}
    onRetry={noop}
    onNewArtist={noop}
    onDuplicate={noop}
    onArt={noop}
  />
)

describe('WAV in the submit flow', () => {
  it('the picker accepts WAV; per-type limits; the tus upload declares its type', async () => {
    stubFetch({ 'POST /api/batches': { status: 201, body: { id: 11 } } })
    tusUploads.length = 0
    render(<SubmitFlow initialBatchId={null} initialItems={[]} rights={{ version: 'v', text: 't' }} maxMp3UploadBytes={100 * MB} maxWavUploadBytes={250 * MB} chunkBytes={8 * MB} maxItemsPerBatch={20} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.accept.split(',')).toEqual(expect.arrayContaining(['.mp3', '.wav', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave']))
    expect(screen.getByText(/WAV: up to 250 MB each/)).toBeTruthy()
    expect(screen.getByText(/MP3: up to 100 MB each · 30 s to 24 min/)).toBeTruthy()
    expect(screen.getByText(/Big files are converted down \(as low as 192 kbps\) so they fit/)).toBeTruthy()

    fireEvent.change(input, {
      target: {
        files: [sized('big.wav', 'audio/wav', 200 * MB), sized('huge.wav', 'audio/wav', 251 * MB), sized('big.mp3', 'audio/mpeg', 101 * MB), sized('ok.mp3', 'audio/mpeg', 60 * MB)],
      },
    })
    expect(await screen.findByText(/The limit for WAV files is 250 MB/)).toBeTruthy()
    expect(screen.getByText(/The limit for MP3 files is 100 MB/)).toBeTruthy()
    const phase = (name: string) => document.querySelector(`li[data-entry] p[title="${name}"]`)!.closest('li')!.getAttribute('data-phase')
    expect(phase('huge.wav')).toBe('blocked')
    expect(phase('big.mp3')).toBe('blocked')
    expect(phase('ok.mp3')).not.toBe('blocked') // v0.3.2: a 60 MB MP3 is uploaded and converted down

    // The two acceptable files are uploaded (2 at a time), each declaring its type.
    await vi.waitFor(() => expect(tusUploads.length).toBe(2))
    const byName = Object.fromEntries(tusUploads.map((u) => [u.file.name, u.opts]))
    expect(byName['big.wav']!.metadata).toEqual({ filetype: 'audio/wav' })
    expect(byName['ok.mp3']!.metadata).toEqual({ filetype: 'audio/mpeg' })
    expect(byName['big.wav']!.endpoint).toBe('/api/uploads')
  })

  it('an item converted from a WAV says so; an MP3 does not', () => {
    stubFetch({})
    render(card({ item: { id: 7, status: 'pending', inputFormat: 'wav', transcodeKbps: 320, durationS: 200, bitrate: 320000, title: 'T', artist: 'A' } as never }))
    expect(screen.getByText('Converted from WAV (320 kbps MP3)')).toBeTruthy()
    expect(screen.getByText(/320 kbps/, { selector: 'p' })).toBeTruthy()
    cleanupAll()
    render(card({ item: { id: 7, status: 'pending', inputFormat: 'wav', transcodeKbps: 256, durationS: 1000, bitrate: 256000, title: 'T', artist: 'A' } as never }))
    expect(screen.getByText('Converted from WAV (256 kbps MP3)')).toBeTruthy()
    cleanupAll()
    render(card({ fileName: 'song.mp3', item: { id: 7, status: 'pending', inputFormat: 'mp3', transcodeKbps: null, durationS: 200, bitrate: 192000, title: 'T', artist: 'A' } as never }))
    expect(screen.queryByText(/Converted from WAV/)).toBeNull()
    expect(screen.queryByText(/Re-encoded/)).toBeNull()
    cleanupAll()
    render(card({ fileName: 'long.mp3', size: 50 * MB, item: { id: 7, status: 'pending', inputFormat: 'mp3', transcodeKbps: 192, durationS: 1300, bitrate: 192000, title: 'T', artist: 'A' } as never }))
    expect(screen.getByText('Re-encoded to 192 kbps to fit')).toBeTruthy()
  })

  it('while a WAV is being checked, the card says it is being converted', () => {
    stubFetch({})
    render(card({ phase: 'probing', item: undefined }))
    expect(screen.getByRole('status').textContent).toMatch(/converting it to an MP3/)
    cleanupAll()
    render(card({ phase: 'probing', fileName: 'long.mp3', size: 50 * MB, item: undefined }))
    expect(screen.getByRole('status').textContent).toMatch(/converting it down so it fits/)
  })

  it('every rejection code the WAV path can raise has a human message', () => {
    const src = ['src/probe/wav.ts', 'src/probe/probe.ts', 'src/probe/transcode.ts'].map((p) => readFileSync(p, 'utf8')).join('\n')
    const codes = new Set([...src.matchAll(/ProbeReject\('([a-z0-9_]+)'\)/g)].map((m) => m[1]!))
    expect(codes.size).toBeGreaterThan(20)
    const missing = [...codes].filter((c) => !PROBE_ERROR_TEXT[c] && !['id3_frame_overflow'].includes(c))
    expect(missing).toEqual([])
  })
})

function cleanupAll() {
  document.body.innerHTML = ''
}
