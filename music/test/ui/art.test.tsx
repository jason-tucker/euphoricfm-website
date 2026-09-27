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

// Server-faithful fixtures (the foundation's src/server/art/uploads.ts):
// uuid art ids, previews at the signed /api/media/art/:id, the probe's
// rejection reasons.
const A1 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const B2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const C3 = '16fd2706-8baf-433b-82eb-8c7fada847da'
const D4 = '886313e1-3b8a-4372-9b90-0c9aee199e5d'
const E5 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const preview = (id: string) => `/api/media/art/${id}?exp=1790000000&sig=${'s'.repeat(43)}`

describe('album art control (the foundation art contract)', () => {
  it('shows a friendly "No album art" prompt with an upload button when there is none', () => {
    render(<ArtControl src={null} attach={async () => {}} />)
    expect(screen.getByText('No album art')).toBeTruthy()
    expect(screen.getByText('Upload art')).toBeTruthy()
    expect(document.querySelector('[data-art="missing"]')).toBeTruthy()
  })

  it('uploads, waits for the probe, then attaches the ready art and shows it', async () => {
    let polls = 0
    const calls = stubFetch({
      'POST /api/uploads/art': { status: 202, body: { artId: A1, status: 'processing' } },
      [`GET /api/uploads/art/${A1}`]: () =>
        ++polls < 2 ? { status: 200, body: { artId: A1, status: 'processing' } } : { status: 200, body: { artId: A1, status: 'ready', previewUrl: preview(A1), width: 1000, height: 1000 } },
    })
    const attach = vi.fn(async () => {})
    const onChange = vi.fn()
    render(<ArtControl src={null} attach={attach} onChange={onChange} />)
    pick(png())
    await vi.waitFor(() => expect(attach).toHaveBeenCalledWith(A1, preview(A1)), { timeout: 5000 })
    await vi.waitFor(() => expect((screen.getByAltText('Album art') as HTMLImageElement).src).toContain(`/api/media/art/${A1}`))
    expect(onChange).toHaveBeenCalledWith(true)
    expect(screen.getByText('Replace art')).toBeTruthy()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/uploads/art')
    expect(post.body).toEqual([['art', 'file']]) // exactly one multipart field `art`
  })

  it('a rejected image shows a readable reason and attaches nothing', async () => {
    stubFetch({
      'POST /api/uploads/art': { status: 202, body: { artId: B2, status: 'processing' } },
      [`GET /api/uploads/art/${B2}`]: { status: 200, body: { artId: B2, status: 'rejected', reason: 'image_decode_failed' } },
    })
    const attach = vi.fn(async () => {})
    render(<ArtControl src={null} attach={attach} />)
    pick(png())
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/couldn't be used/i))
    expect(attach).not.toHaveBeenCalled()
  })

  it('a known rejection reason and an expired upload are explained, nothing is attached', async () => {
    stubFetch({
      'POST /api/uploads/art': { status: 202, body: { artId: E5, status: 'processing' } },
      [`GET /api/uploads/art/${E5}`]: { status: 200, body: { artId: E5, status: 'rejected', reason: 'image_too_large' } },
    })
    const attach = vi.fn(async () => {})
    render(<ArtControl src={null} attach={attach} />)
    pick(png())
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/12 megapixels/))
    expect(attach).not.toHaveBeenCalled()
  })

  it('an upload refused by the server (HTTP) shows its reason', async () => {
    stubFetch({ 'POST /api/uploads/art': { status: 415, body: { error: 'unsupported_image_type' } } })
    const attach = vi.fn(async () => {})
    render(<ArtControl src={null} attach={attach} />)
    pick(png())
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/JPEG, PNG or WebP/))
    expect(attach).not.toHaveBeenCalled()
  })

  it('a 409 when attaching (item no longer pending) is explained', async () => {
    stubFetch({
      'POST /api/uploads/art': { status: 202, body: { artId: C3, status: 'processing' } },
      [`GET /api/uploads/art/${C3}`]: { status: 200, body: { artId: C3, status: 'ready', previewUrl: preview(C3) } },
      // P3's setItemArt: 409 not_editable once the item is decided / submitted
      'PUT /api/items/4/art': { status: 409, body: { error: 'not_editable' } },
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
      'POST /api/uploads/art': { status: 202, body: { artId: D4, status: 'processing' } },
      [`GET /api/uploads/art/${D4}`]: { status: 200, body: { artId: D4, status: 'ready', previewUrl: preview(D4) } },
      'POST /api/requests': { status: 201, body: { id: 21 } },
    })
    render(<RequestForms mediaId={77} current={{ title: 'T', artist: 'A', album: '', genre: '' }} currentArtUrl={null} />)
    pick(png())
    await vi.waitFor(() => expect(screen.getByText('New album art (proposed)')).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: 'Send edit request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    await vi.waitFor(() => expect(screen.getByText(/request #21 was filed/i)).toBeTruthy())
    expect(calls.find((c) => c.url === '/api/requests')!.body).toEqual({ kind: 'edit', mediaId: 77, proposed: { artId: D4 } })
  })
})
