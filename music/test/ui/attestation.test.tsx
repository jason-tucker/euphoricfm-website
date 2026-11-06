import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SubmitPanel } from '@/components/submit/SubmitPanel'

const rights = { version: 'v-test-1', text: 'I own this recording.' }
const rows = [{ key: 'a', name: 'Artist – Song', newArtist: true, edited: false, duplicate: false }]

function setup(blockers: string[] = []) {
  const onSubmit = vi.fn(async () => null)
  render(<SubmitPanel rights={rights} rows={rows} blockers={blockers} notes="" onNotes={() => {}} onSubmit={onSubmit} />)
  return { onSubmit, button: screen.getByRole('button', { name: /review and submit/i }), box: screen.getByRole('checkbox') }
}

describe('rights attestation is required to submit', () => {
  it('shows the versioned rights text from settings', () => {
    setup()
    expect(screen.getByText('I own this recording.')).toBeTruthy()
    expect(screen.getByText(/Rights statement version v-test-1/i)).toBeTruthy()
  })

  it('the submit button is disabled and nothing is sent until the box is ticked', () => {
    const { onSubmit, button, box } = setup()
    expect((box as HTMLInputElement).checked).toBe(false)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(screen.queryByText('Submit this batch?', { selector: 'h2' })?.closest('dialog')?.hasAttribute('open') ?? false).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/tick the rights statement/i)).toBeTruthy()
  })

  it('once ticked, the confirmation shows the summary and submits with attest=true and the version', async () => {
    const { onSubmit, button, box } = setup()
    fireEvent.click(box)
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    const dialog = screen.getByRole('heading', { name: 'Submit this batch?' }).closest('dialog')!
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(dialog.textContent).toContain('Artist – Song')
    expect(dialog.textContent).toContain('NEW ARTIST')
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ attest: true, version: 'v-test-1' }))
  })

  it('unticking again blocks submission', () => {
    const { onSubmit, button, box } = setup()
    fireEvent.click(box)
    fireEvent.click(box)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('a blocker (files still uploading) is shown instead of opening the confirmation', () => {
    const { onSubmit, button, box } = setup(['Wait until every file has finished uploading and checking.'])
    fireEvent.click(box)
    fireEvent.click(button)
    expect(screen.getByRole('alert').textContent).toContain('Wait until every file')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('a server refusal (attestation_required) is shown as a readable message', async () => {
    const onSubmit = vi.fn(async () => 'You must confirm the rights statement before submitting.')
    render(<SubmitPanel rights={rights} rows={rows} blockers={[]} notes="" onNotes={() => {}} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /review and submit/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('You must confirm the rights statement'))
  })
})
