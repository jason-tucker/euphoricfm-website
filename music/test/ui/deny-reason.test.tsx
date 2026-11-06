import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DecisionPanel } from '@/components/review/DecisionPanel'
import { stubFetch } from './fetch'

const base = {
  itemId: 7,
  kind: 'song' as const,
  isSelf: false,
  assignable: [{ id: 2, label: '1General Rotation (#2)' }],
  initialPlaylistIds: [2],
  initialFields: { title: 'Song', artist: 'Artist', album: '', genre: '' },
}

describe('deny requires a reason', () => {
  it('confirming a deny with an empty reason is blocked and sends nothing', async () => {
    const calls = stubFetch({})
    const onDecided = vi.fn()
    render(<DecisionPanel {...base} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    expect(screen.getByRole('alert').textContent).toMatch(/reason is required/i)
    // whitespace-only is still empty
    fireEvent.change(screen.getByLabelText(/reason for denying/i), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    expect(screen.getByRole('alert').textContent).toMatch(/reason is required/i)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.filter((c) => c.url.includes('/decision'))).toHaveLength(0)
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('with a reason, POSTs {decision: deny, reason} to the decision route', async () => {
    const calls = stubFetch({ 'POST /api/items/7/decision': { status: 200, body: { id: 7, status: 'denied' } } })
    const onDecided = vi.fn()
    render(<DecisionPanel {...base} onDecided={onDecided} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }))
    fireEvent.change(screen.getByLabelText(/reason for denying/i), { target: { value: '  Audio clips at 1:20  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    await vi.waitFor(() => expect(onDecided).toHaveBeenCalledWith('denied'))
    const d = calls.find((c) => c.url === '/api/items/7/decision')!
    expect(d.method).toBe('POST')
    expect(d.body).toEqual({ decision: 'deny', reason: 'Audio clips at 1:20' })
  })

  it("the server's invalid_decision refusal is shown readably", async () => {
    stubFetch({ 'POST /api/items/7/decision': { status: 400, body: { error: 'invalid_decision', issues: ['reason required'] } } })
    render(<DecisionPanel {...base} onDecided={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }))
    fireEvent.change(screen.getByLabelText(/reason for denying/i), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('A denial needs a reason'))
  })
})
