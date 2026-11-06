import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { proposedChanges, RequestForms } from '@/components/requests/RequestForms'
import { RequestDecision } from '@/components/requests/RequestDecision'
import { ResolveArchiveButton } from '@/components/requests/ResolveArchiveButton'
import { stubFetch } from './fetch'

const current = { title: 'Song', artist: 'GRIM', album: 'Night', genre: 'House' }

describe('P4 request forms (routes guessed in src/lib/api/requests.ts)', () => {
  it('an edit request needs at least one changed field and sends only the changes as `proposed`', async () => {
    const calls = stubFetch({ 'POST /api/requests': { status: 201, body: { id: 12 } } })
    render(<RequestForms mediaId={501} current={current} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send edit request' }))
    expect(screen.getByRole('alert').textContent).toMatch(/change at least one field/i)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Song (Radio Edit)' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send edit request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    await vi.waitFor(() => expect(screen.getByText(/request #12 was filed/i)).toBeTruthy())
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/requests')!
    expect(post.body).toEqual({ kind: 'edit', mediaId: 501, proposed: { title: 'Song (Radio Edit)' } })
  })

  it('a removal request requires a reason', async () => {
    const calls = stubFetch({ 'POST /api/requests': { status: 201, body: { id: 13 } } })
    render(<RequestForms mediaId={501} current={current} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Request removal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send removal request' }))
    expect(screen.getByRole('alert').textContent).toMatch(/why this song should be removed/i)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    fireEvent.change(screen.getByLabelText(/why should it be removed/i), { target: { value: 'Duplicate upload' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send removal request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ kind: 'removal', mediaId: 501, reason: 'Duplicate upload' }))
  })

  it('proposedChanges ignores unchanged and emptied fields', () => {
    expect(proposedChanges(current, { ...current, artist: ' GRIM ', album: '' })).toEqual({})
    expect(proposedChanges(current, { ...current, genre: 'Techno' })).toEqual({ genre: 'Techno' })
  })

  it('reviewer deny needs a reason; a lost race shows the 409 message', async () => {
    const calls = stubFetch({ 'POST /api/requests/5/decision': { status: 409, body: { error: 'state_changed' } } })
    render(<RequestDecision id={5} kind="edit" isSelf={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    expect(screen.getByRole('alert').textContent).toMatch(/reason is required/i)
    expect(calls).toHaveLength(0)
    fireEvent.change(screen.getByLabelText(/reason for denying/i), { target: { value: 'Tags are right' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/someone else already decided/i))
    expect(calls[0]!.body).toEqual({ decision: 'deny', reason: 'Tags are right' })
  })

  it('Resolve on an archive that stopped part way POSTs the reconcile route; a busy row shows a readable reason', async () => {
    const calls = stubFetch({ 'POST /api/archive/7/reconcile': { status: 202, body: { queued: 'reconcile_archive', archiveId: 7 } } })
    const { unmount } = render(<ResolveArchiveButton archiveId={7} name="stranded.mp3" status="archiving" />)
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(screen.getByText(/stopped part way through archiving/i)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Resolve' }).at(-1)!)
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/archive/7/reconcile']))
    unmount()
    stubFetch({ 'POST /api/archive/8/reconcile': { status: 409, body: { error: 'archive_job_pending' } } })
    render(<ResolveArchiveButton archiveId={8} name="busy.mp3" status="restoring" />)
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(screen.getByText(/stopped part way through restoring/i)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Resolve' }).at(-1)!)
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/still working on this archive or restore/i))
  })
})
