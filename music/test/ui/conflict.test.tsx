import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { api, ApiError, messageFor } from '@/components/api'
import { DecisionPanel } from '@/components/review/DecisionPanel'
import { QueueList } from '@/components/review/QueueList'
import { WithdrawButton } from '@/components/WithdrawButton'
import type { UiItem } from '@/server/ui/queries'
import { stubFetch } from './fetch'

const CONFLICT = /someone else already decided/i

describe('409 race conflicts show a readable message', () => {
  it('approve that loses the race → "someone else already decided this"', async () => {
    stubFetch({ 'POST /api/items/9/decision': { status: 409, body: { error: 'state_changed' } } })
    const onDecided = vi.fn()
    render(
      <DecisionPanel
        itemId={9}
        kind="song"
        isSelf={false}
        assignable={[{ id: 2, label: '1General Rotation (#2)' }]}
        initialPlaylistIds={[2]}
        initialFields={{ title: 'T', artist: 'A', album: '', genre: '' }}
        onDecided={onDecided}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1)!) // the dialog's confirm
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(CONFLICT))
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('deny that loses the race → same message', async () => {
    stubFetch({ 'POST /api/items/9/decision': { status: 409, body: { error: 'state_changed' } } })
    render(
      <DecisionPanel
        itemId={9}
        kind="song"
        isSelf={false}
        assignable={[{ id: 2, label: 'x' }]}
        initialPlaylistIds={[2]}
        initialFields={{ title: 'T', artist: 'A', album: '', genre: '' }}
        onDecided={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }))
    fireEvent.change(screen.getByLabelText(/reason for denying/i), { target: { value: 'dup' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(CONFLICT))
  })

  it('self-approval shows the warning before approving', () => {
    stubFetch({})
    render(
      <DecisionPanel
        itemId={9}
        kind="song"
        isSelf
        assignable={[{ id: 2, label: 'x' }]}
        initialPlaylistIds={[2]}
        initialFields={{ title: 'T', artist: 'A', album: '', genre: '' }}
        onDecided={() => {}}
      />,
    )
    expect(screen.getByText(/this is your own submission/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.getByRole('button', { name: 'Approve (self-approved)' })).toBeTruthy()
  })

  it('bulk approve lists 409s as already decided and counts the rest', async () => {
    stubFetch({
      'POST /api/items/1/decision': { status: 200, body: { id: 1, status: 'approved' } },
      'POST /api/items/2/decision': { status: 409, body: { error: 'state_changed' } },
    })
    const it1 = { id: 1, batchId: 5, kind: 'song', source: 'upload', status: 'pending', title: 'One', artist: 'A', isOwn: false } as UiItem
    const it2 = { ...it1, id: 2, title: 'Two' } as UiItem
    render(<QueueList groups={[{ batchId: 5, submittedAt: null, ownerName: 'M', ticketNumber: 3, items: [it1, it2] }]} defaultPlaylistLabels={['1General Rotation (#2)']} />)
    fireEvent.click(screen.getByLabelText('Select all songs'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected (2)' }))
    expect(screen.getByRole('heading', { name: 'Approve 2 songs?' }).closest('dialog')!.textContent).toContain('1General Rotation (#2)')
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    await vi.waitFor(() => expect(screen.getByText(/approved 1 of 2/i)).toBeTruthy())
    expect(screen.getByText(/someone else already decided: A – Two/i)).toBeTruthy()
  })

  it('withdraw that loses the race explains the item is no longer pending', async () => {
    stubFetch({ 'POST /api/items/4/withdraw': { status: 409, body: { error: 'state_changed' } } })
    render(<WithdrawButton itemId={4} name="A – T" />)
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Withdraw' }).at(-1)!)
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/no longer pending/i))
  })

  it('messageFor maps codes, generic 409s, missing endpoints and network failures', async () => {
    expect(messageFor(new ApiError(409, 'state_changed'), 'decision')).toMatch(CONFLICT)
    expect(messageFor(new ApiError(409, 'batch_not_draft'))).toMatch(/already been submitted/)
    expect(messageFor(new ApiError(409, 'something_new'))).toMatch(/changed while you were looking/)
    expect(messageFor(new ApiError(403, 'csrf_origin'))).toMatch(/did not come from the portal/)
    stubFetch({ 'PATCH /api/items/1': { status: 404, html: true } })
    await expect(api('/api/items/1', { method: 'PATCH', json: {} })).rejects.toMatchObject({ code: 'endpoint_missing' })
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    await expect(api('/api/me')).rejects.toMatchObject({ code: 'network' })
  })
})
