import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ArtControl } from '@/components/ArtControl'
import { RequestForms } from '@/components/requests/RequestForms'
import { SubmitPanel } from '@/components/submit/SubmitPanel'
import { precheckArt } from '@/lib/api/art'
import { stubFetch } from './fetch'

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cover.png', { type: 'image/png' })

function pick(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

describe('album art control (routes from the art contract)', () => {
  it('shows a friendly "No album art" prompt with an upload button when there is none', () => {
    render(<ArtControl src={null} attach={async () => {}} />)
    expect(screen.getByText('No album art')).toBeTruthy()
    expect(screen.getByText('Upload art')).toBeTruthy()
    expect(document.querySelector('[data-art="missing"]')).toBeTruthy()
  })

  it('uploads, waits for the probe, then attaches the ready art and shows it', async () => {
    let polls = 0
    const calls = stubFetch({
      'POST /api/uploads/art': { status: 202, body: { artId: 'a1', status: 'processing' } },
      'GET /api/uploads/art/a1': () => (++polls < 2 ? { status: 200, body: { artId: 'a1', status: 'processing' } } : { status: 200, body: { artId: 'a1', status: 'ready', previewUrl: '/api/art/a1?sig=x' } }),
    })
    const attach = vi.fn(async () => {})
    const onChange = vi.fn()
    render(<ArtControl src={null} attach={attach} onChange={onChange} />)
    pick(png())
    await vi.waitFor(() => expect(attach).toHaveBeenCalledWith('a1', '/api/art/a1?sig=x'), { timeout: 5000 })
    await vi.waitFor(() => expect((screen.getByAltText('Album art') as HTMLImageElement).src).toContain('/api/art/a1'))
    expect(onChange).toHaveBeenCalledWith(true)
    expect(screen.getByText('Replace art')).toBeTruthy()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/uploads/art')
  })

  it('a rejected image shows a readable reason and attaches nothing', async () => {
    stubFetch({
      'POST /api/uploads/art': { status: 202, body: { artId: 'b2', status: 'processing' } },
      'GET /api/uploads/art/b2': { status: 200, body: { artId: 'b2', status: 'rejected', reason: 'bad_image' } },
    })
    const attach = vi.fn(async () => {})
    render(<ArtControl src={null} attach={attach} />)
    pick(png())
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/couldn't be used/i))
    expect(attach).not.toHaveBeenCalled()
  })

  it('a 409 when attaching (item no longer pending) is explained', async () => {
    stubFetch({
      'POST /api/uploads/art': { status: 202, body: { artId: 'c3', status: 'processing' } },
      'GET /api/uploads/art/c3': { status: 200, body: { artId: 'c3', status: 'ready', previewUrl: '/x' } },
      'PUT /api/items/4/art': { status: 409, body: { error: 'state_changed' } },
    })
    const { ItemArtControl } = await import('@/components/ItemArtControl')
    render(<ItemArtControl itemId={4} src={null} hasCustomArt={false} />)
    pick(png())
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/changed while you were editing/i))
  })

  it('advisory pre-check: only JPEG/PNG/WebP up to 5 MB, nothing sent otherwise', () => {
    expect(precheckArt({ name: 'a.gif', size: 10, type: 'image/gif' })).toBe('art_type')
    expect(precheckArt({ name: 'a.jpg', size: 6 * 1024 * 1024, type: 'image/jpeg' })).toBe('art_too_large')
    expect(precheckArt({ name: 'a.webp', size: 10, type: '' })).toBeNull()
    const calls = stubFetch({})
    render(<ArtControl src={null} attach={async () => {}} />)
    pick(new File(['GIF89a'], 'x.gif', { type: 'image/gif' }))
    expect(screen.getByRole('alert').textContent).toMatch(/JPEG, PNG or WebP/)
    expect(calls).toHaveLength(0)
  })
})

describe('missing art never blocks submission', () => {
  it('the confirm dialog lists songs without art, and submitting still works', async () => {
    const onSubmit = vi.fn(async () => null)
    const rows = [
      { key: 'a', name: 'A – One', newArtist: false, edited: false, duplicate: false, noArt: true },
      { key: 'b', name: 'B – Two', newArtist: false, edited: false, duplicate: false, noArt: false },
    ]
    render(<SubmitPanel rights={{ version: 'v', text: 'rights' }} rows={rows} blockers={[]} notes="" onNotes={() => {}} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /review and submit/i }))
    const list = screen.getByTestId('no-art-list')
    expect(list.textContent).toContain('No album art on 1 song')
    expect(list.textContent).toContain('A – One')
    expect(list.textContent).not.toContain('B – Two')
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled())
  })
})

describe('edit request can propose art alone', () => {
  it('sends proposed.artId with no metadata changes', async () => {
    const calls = stubFetch({
      'POST /api/uploads/art': { status: 202, body: { artId: 'd4', status: 'processing' } },
      'GET /api/uploads/art/d4': { status: 200, body: { artId: 'd4', status: 'ready', previewUrl: '/p' } },
      'POST /api/requests': { status: 201, body: { id: 21 } },
    })
    render(<RequestForms mediaId={77} current={{ title: 'T', artist: 'A', album: '', genre: '' }} currentArtUrl={null} />)
    pick(png())
    await vi.waitFor(() => expect(screen.getByText('New album art (proposed)')).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: 'Send edit request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    await vi.waitFor(() => expect(screen.getByText(/request #21 was filed/i)).toBeTruthy())
    expect(calls.find((c) => c.url === '/api/requests')!.body).toEqual({ kind: 'edit', mediaId: 77, proposed: { artId: 'd4' } })
  })
})
