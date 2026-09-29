import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RoleBindings } from '@/components/admin/RoleBindings'
import { SettingsForm } from '@/components/admin/SettingsForm'
import { ApiError, messageFor } from '@/components/api'
import { ArtistDecision } from '@/components/requests/ArtistDecision'
import { stubFetch } from './fetch'

const b = { id: 3, roleId: '1144462744456794153', permission: 'review' as const, note: 'EFM Managers', createdBy: 'seed', createdAt: '2026-09-27T00:00:00Z' }

describe('role bindings (P4 admin routes)', () => {
  it('validates the role id locally, then POSTs; 409 binding_exists is readable', async () => {
    const calls = stubFetch({ 'POST /api/admin/role-bindings': { status: 409, body: { error: 'binding_exists' } } })
    render(<RoleBindings bindings={[b]} />)
    fireEvent.change(screen.getByLabelText('Discord role id'), { target: { value: '123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }))
    expect(screen.getByRole('alert').textContent).toMatch(/17–20 digits/)
    expect(calls).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Discord role id'), { target: { value: '1144462744456794153' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }))
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already has this permission/))
    expect(calls[0]!.body).toEqual({ roleId: '1144462744456794153', permission: 'review' })
  })
  it('removes after confirmation with DELETE', async () => {
    const calls = stubFetch({ 'DELETE /api/admin/role-bindings/3': { status: 200, body: { id: 3 } } })
    render(<RoleBindings bindings={[b]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!)
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/admin/role-bindings/3')).toBe(true))
  })
})

describe('P4 codes and the new-artist wait', () => {
  it('daily_cap names the limit; other P4 codes are readable', () => {
    expect(messageFor(new ApiError(429, 'daily_cap', [], { error: 'daily_cap', limit: 10 }))).toMatch(/limit of 10/)
    for (const c of ['duplicate_request', 'no_change', 'invalid_request', 'artist_not_active', 'not_archived', 'unknown_setting', 'invalid_setting', 'default_not_assignable', 'binding_exists', 'invalid_binding']) {
      expect(messageFor(new ApiError(400, c))).not.toMatch(/request failed/)
    }
  })
  it('denying a waiting artist needs a reason, then POSTs to the artist decision route', async () => {
    const calls = stubFetch({ 'POST /api/requests/artists/9/decision': { status: 200, body: { id: 9, status: 'denied', folder: 'X' } } })
    render(<ArtistDecision artistId={9} name="X" folder="X" />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    expect(screen.getByRole('alert').textContent).toMatch(/reason is required/i)
    fireEvent.change(screen.getByLabelText(/reason for denying/i), { target: { value: 'typo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    await vi.waitFor(() => expect(calls[0]?.body).toEqual({ decision: 'deny', reason: 'typo' }))
  })
})

const settingsInput = (soundcloudEnabled?: boolean) => ({
  assignablePlaylistIds: [1],
  stationPlaylistIds: [1],
  foreignPlaylistIds: [],
  defaultPlaylistIds: [1],
  playlistNames: { '1': 'General Rotation' },
  autoCloseDays: 7,
  caps: { maxItemsPerBatch: 20, ingestPerHour: 6, ingestSpacingS: 600, fetchesPerUserPerDay: 20 },
  rights: { version: 'v1', text: 'I own it.' },
  inviteUrl: null,
  ...(soundcloudEnabled === undefined ? {} : { soundcloudEnabled }),
})

describe('v0.4.1: the SoundCloud kill switch help text', () => {
  it('says the switch is on by default and that music-fetch relies on the botvps host rules (keep it off on a new server)', () => {
    render(<SettingsForm initial={settingsInput(true)} />)
    expect(screen.getByLabelText('Allow “Add from a SoundCloud link”')).toBeTruthy()
    const note = screen.getByTestId('sc-host-note').textContent!
    expect(note).toMatch(/On by default \(no saved setting counts as on\)/)
    expect(note).toMatch(/botvps host firewall \(efm-music-egress\)/)
    expect(note).toMatch(/keep this off until those rules are verified/)
  })
})

describe('v0.4.0: the SoundCloud kill switch saves as its own setting', () => {
  it('no saved setting shows ON; turning it off PUTs soundcloud_fetch_enabled=false and nothing else', async () => {
    const calls = stubFetch({ 'PUT /api/admin/settings': (body) => ({ status: 200, body }) })
    render(<SettingsForm initial={settingsInput()} />)
    const box = screen.getByLabelText('Allow “Add from a SoundCloud link”') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(box.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await vi.waitFor(() => expect(screen.getByText('Saved: soundcloud_fetch_enabled.')).toBeTruthy())
    expect(calls).toEqual([{ method: 'PUT', url: '/api/admin/settings', body: { key: 'soundcloud_fetch_enabled', value: false } }])
  })

  it('a saved OFF shows off; turning it back on PUTs true', async () => {
    const calls = stubFetch({ 'PUT /api/admin/settings': (body) => ({ status: 200, body }) })
    render(<SettingsForm initial={settingsInput(false)} />)
    const box = screen.getByLabelText('Allow “Add from a SoundCloud link”') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({ key: 'soundcloud_fetch_enabled', value: true })
  })

  it('unchanged: Save sends nothing', () => {
    const calls = stubFetch({})
    render(<SettingsForm initial={settingsInput(true)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(screen.getByText('Nothing changed.')).toBeTruthy()
    expect(calls).toEqual([])
  })
})
