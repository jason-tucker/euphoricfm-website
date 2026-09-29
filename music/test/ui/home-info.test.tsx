// v0.3.4 portal home information: the signed-out page (hero, glance, who /
// needs, steps + status legend, files and limits from the limits helper,
// "We can't take", the rights statement exactly as the submit page shows it,
// edits and removals, FAQ, links) and the condensed signed-in version.
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SITE_LINKS } from '@/components/site-links'
import { ITEM_STATUS } from '@/components/messages'
import { SubmitPanel } from '@/components/submit/SubmitPanel'
import { MAX_DURATION_S, MAX_MP3_UPLOAD_BYTES, MIN_LADDER_BITRATE } from '@/lib/fit'
import { MIN_BITRATE, MIN_DURATION_S } from '@/probe/probe'
import { MAX_EDGE, MAX_PIXELS } from '@/probe/cover'
import { DEFAULT_CAPS, MB, type Caps } from '@/server/settings-defaults'
import { uploadLimitsForUi } from '@/server/ui/limits'

type V = { userId: string; discordId: string; name: string; perms: Set<string> }
const RIGHTS = { version: '2026-09-27', text: 'I own this recording, or I have permission from everyone who holds rights in it. Test copy with “quotes” & ampersand.' }
const state = vi.hoisted(() => ({
  viewer: null as null | V,
  caps: null as null | Record<string, unknown>,
  invite: null as null | string,
  sc: false,
}))

vi.mock('@/app/actions', () => ({ signInWithDiscord: vi.fn(), signOutAction: vi.fn(), signInToSuggestEdit: vi.fn(), signInToRequestRemoval: vi.fn() }))
vi.mock('@/server/db/client', () => ({ getDb: () => ({}) }))
vi.mock('@/server/ui/queries', () => ({
  memberSummary: async () => ({ inReview: 1, onAir: 0, openRequests: 1 }),
  reviewSummary: async () => ({ songs: 2, requests: 0 }),
}))
vi.mock('@/server/requests/service', () => ({ dailyCaps: async () => ({ edit: 4, removal: 6 }) }))
vi.mock('@/server/ui/settings', async () => {
  const { DEFAULT_CAPS: caps } = await import('@/server/settings-defaults')
  return {
    uiSettings: async () => ({
      rights: RIGHTS,
      inviteUrl: state.invite,
      autoCloseDays: 9,
      caps: { ...caps, ...(state.caps ?? {}) },
      requestCaps: { edit: 4, removal: 6 },
      soundcloudEnabled: state.sc,
    }),
  }
})
vi.mock('@/server/ui/page', () => ({ headerViewer: async () => state.viewer }))

const member: V = { userId: 'u1', discordId: '100000000000000001', name: 'Mia', perms: new Set(['submit', 'request']) }

beforeEach(() => {
  state.viewer = null
  state.caps = null
  state.invite = null
  state.sc = false
})

describe('uploadLimitsForUi (the one source of upload figures)', () => {
  it('reads the compiled constants and the default caps', () => {
    const l = uploadLimitsForUi(DEFAULT_CAPS)
    expect(l.mp3MaxBytes).toBe(DEFAULT_CAPS.maxMp3UploadBytes)
    expect(l.mp3MaxBytes).toBe(MAX_MP3_UPLOAD_BYTES)
    expect(l.wavMaxBytes).toBe(DEFAULT_CAPS.maxWavUploadBytes)
    expect(l.maxMinutes).toBe(MAX_DURATION_S / 60)
    expect(l.minSeconds).toBe(MIN_DURATION_S)
    expect(l.minKbps).toBe(MIN_BITRATE / 1000)
    expect(l.ladderKbps).toEqual([320, 256, 192])
    expect(l.minFitKbps).toBe(MIN_LADDER_BITRATE / 1000)
    expect(l.maxItemsPerBatch).toBe(DEFAULT_CAPS.maxItemsPerBatch)
    expect(l.text.mp3Size).toBe('up to 100 MB')
    expect(l.text.wavSize).toBe(`up to ${DEFAULT_CAPS.maxWavUploadBytes / MB} MB`)
    expect(l.text.mp3Length).toBe(`${MIN_DURATION_S} seconds to ${MAX_DURATION_S / 60} minutes`)
    expect(l.text.mp3Length).toBe('30 seconds to 24 minutes')
    expect(l.text.wavLength).toBe('30 seconds to 24 minutes')
    // Fit-to-size (v0.3.5): the ladder and the untouched-MP3 promise.
    expect(l.note).toContain('as low as 192 kbps')
    expect(l.note).toContain('320 kbps for songs up to 14 minutes, 256 kbps up to 18, 192 kbps up to 24')
    expect(l.note).toContain('An MP3 that already fits is never changed.')
    expect(l.text.wavConvert).toBe('convert it to a 320, 256 or 192 kbps MP3, the highest that fits')
    expect(l.text.tooLong).toBe('MP3s over 100 MB or WAVs over 250 MB, songs under 30 seconds, and songs over 24 minutes (the most that fits even at 192 kbps).')
    // Cover art: the pixel cap the probe enforces (dimsAcceptable) is shown, not just the edge.
    expect(l.text.artSize).toContain(`${MAX_PIXELS / 1_000_000} megapixels`)
    expect(l.text.artSize).toContain(`${MAX_EDGE} px on a side`)
  })

  it('lowered MP3 / WAV caps are shown; the final-file cap is not an upload limit; nothing exceeds the defaults', () => {
    // maxUploadBytes is the 35 MB final-file cap (loadCaps skips a saved one): it never changes the MP3 upload limit.
    expect(uploadLimitsForUi({ ...DEFAULT_CAPS, maxUploadBytes: 20 * MB } as unknown as Caps).mp3MaxBytes).toBe(DEFAULT_CAPS.maxMp3UploadBytes)
    expect(uploadLimitsForUi({ ...DEFAULT_CAPS, maxMp3UploadBytes: 60 * MB } as unknown as Caps).text.mp3Size).toBe('up to 60 MB')
    expect(uploadLimitsForUi({ ...DEFAULT_CAPS, maxMp3UploadBytes: 60 * MB } as unknown as Caps).text.tooLong).toContain('MP3s over 60 MB')
    expect(uploadLimitsForUi({ ...DEFAULT_CAPS, maxMp3UploadBytes: 999 * MB } as unknown as Caps).mp3MaxBytes).toBe(DEFAULT_CAPS.maxMp3UploadBytes)
    expect(uploadLimitsForUi({ ...DEFAULT_CAPS, maxWavUploadBytes: 100 * MB } as unknown as Caps).text.wavSize).toBe('up to 100 MB')
    expect(uploadLimitsForUi({ ...DEFAULT_CAPS, maxWavUploadBytes: 999 * MB } as unknown as Caps).wavMaxBytes).toBe(DEFAULT_CAPS.maxWavUploadBytes)
    expect(uploadLimitsForUi({ maxMp3UploadBytes: 'x' } as unknown as Caps).mp3MaxBytes).toBe(DEFAULT_CAPS.maxMp3UploadBytes)
    expect(uploadLimitsForUi(null).maxItemsPerBatch).toBe(DEFAULT_CAPS.maxItemsPerBatch)
  })
})

describe('home page, signed out', async () => {
  const { default: Home } = await import('@/app/page')

  it('hero, glance, who / needs, four steps and the real status labels', async () => {
    render(await Home({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Get your music on EuphoricFM')
    expect(screen.getByRole('button', { name: /sign in with discord/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /how it works/i }).getAttribute('href')).toBe('#how-h')
    expect(screen.getByTestId('at-a-glance').textContent).toContain(`MP3 or WAV, up to ${DEFAULT_CAPS.maxItemsPerBatch} songs at a time`)
    expect(screen.getByRole('heading', { name: 'Who can submit' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'What you’ll need' })).toBeTruthy()
    const steps = within(screen.getByTestId('steps')).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(steps).toEqual(['Step 1: Sign in with Discord', 'Step 2: Upload your songs', 'Step 3: Managers review', 'Step 4: On air'])
    expect(screen.getByTestId('steps').textContent).toContain(uploadLimitsForUi(DEFAULT_CAPS).text.fitShort)
    const legend = screen.getByTestId('status-legend').textContent
    for (const s of ['pending', 'approved', 'applying', 'verifying', 'live', 'denied']) expect(legend).toContain(ITEM_STATUS[s]!.label)
    expect(screen.queryByTestId('action-cards')).toBeNull()
  })

  it('files and limits are the helper’s text (follows lowered MP3 / WAV caps, not the final-file cap)', async () => {
    state.caps = { maxUploadBytes: 20 * MB, maxMp3UploadBytes: 80 * MB, maxWavUploadBytes: 100 * MB, maxItemsPerBatch: 12 }
    render(await Home({ searchParams: Promise.resolve({}) }))
    const l = uploadLimitsForUi({ ...DEFAULT_CAPS, ...state.caps } as unknown as Caps)
    const mp3 = screen.getByTestId('limits-mp3').textContent
    for (const t of [l.text.mp3Size, l.text.mp3Quality, l.text.mp3Length, l.text.mp3Tags, l.text.mp3Fit]) expect(mp3).toContain(t)
    expect(mp3).toContain('up to 80 MB')
    expect(mp3).not.toContain('up to 20 MB')
    const wav = screen.getByTestId('limits-wav').textContent
    for (const t of [l.text.wavSize, l.text.wavFormat, l.text.wavLength, l.text.wavConvert]) expect(wav).toContain(t)
    expect(wav).toContain('up to 100 MB')
    expect(screen.getByTestId('limits-art').textContent).toContain(l.text.batch)
    expect(screen.getByTestId('limits-art').textContent).toContain(l.text.artSize)
    expect(screen.getByTestId('limits-note').textContent).toBe(l.note)
    const cant = screen.getByTestId('cant-take').textContent
    expect(cant).toContain(l.text.tooLong)
    expect(cant).toContain('don’t own')
  })

  it('the rights statement is word for word the one the submit page asks to confirm', async () => {
    render(await Home({ searchParams: Promise.resolve({}) }))
    const home = screen.getByTestId('rights-text')
    expect(home.textContent).toBe(RIGHTS.text)
    expect(home.getAttribute('data-version')).toBe(RIGHTS.version)
    const { container } = render(<SubmitPanel rights={RIGHTS} rows={[]} blockers={[]} notes="" onNotes={() => {}} onSubmit={async () => null} />)
    // The submit panel's statement is the text node right before the version line.
    const submitText = container.querySelector('#rights-version')!.parentElement!.firstChild!
    expect(submitText.nodeType).toBe(Node.TEXT_NODE)
    expect(submitText.textContent).toBe(home.textContent)
  })

  it('edits and removals: sign-in buttons and the request caps', async () => {
    render(await Home({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('button', { name: 'Sign in to suggest an edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in to request removal' })).toBeTruthy()
    expect(screen.getByTestId('request-caps').textContent).toContain('up to 4 edit and 6 removal requests a day')
    // requests/service.ts dedupes per song AND kind: an edit and a removal can both be open.
    expect(screen.getByTestId('request-caps').textContent).toContain('One open edit and one open removal request per song')
  })

  it('FAQ: eight keyboard-reachable <details>, closed by default, with settings-driven answers', async () => {
    render(await Home({ searchParams: Promise.resolve({}) }))
    const faq = screen.getByTestId('faq')
    expect(within(faq).getByRole('heading', { level: 2, name: 'Questions artists ask' })).toBeTruthy()
    const items = faq.querySelectorAll('details')
    expect(items).toHaveLength(8)
    for (const d of items) {
      expect(d.open).toBe(false)
      expect(d.firstElementChild?.tagName).toBe('SUMMARY')
    }
    const text = (id: string) => faq.querySelector(`[data-faq="${id}"]`)!.textContent!
    expect(text('how-long')).toContain('depends on the managers')
    expect(text('how-long')).toContain('after 9 days without activity')
    expect(text('file')).toContain(uploadLimitsForUi(DEFAULT_CAPS).note)
    expect(text('file')).toContain('re-encoded')
    expect(text('file')).toContain('30 seconds to 24 minutes')
    expect(text('edits')).toContain('4 edit and 6 removal requests a day')
    expect(text('edits')).toContain('one open edit and one open removal request per song')
    expect(text('ticket')).toContain('mentions only you')
    expect(text('ticket')).not.toContain('staff roles')
    // v0.4.1: members see their own archived songs since v0.3.6
    expect(text('archived')).toContain('you still see it under Library → My archived songs')
    expect(text('archived')).toContain('only managers can put one back')
    expect(text('archived')).not.toContain('Only the station managers can see them')
  })

  it('links: Listen live to the main site; Join our Discord from the constant, or the admin setting', async () => {
    render(await Home({ searchParams: Promise.resolve({}) }))
    expect(screen.getByTestId('listen-live').getAttribute('href')).toBe(SITE_LINKS.listen)
    expect(screen.getByTestId('discord-invite').getAttribute('href')).toBe(SITE_LINKS.discordInvite)
    expect(SITE_LINKS.discordInvite).toBe('https://discord.gg/QzDESUFmQ2')
    expect(SITE_LINKS.listen).toBe('https://info.euphoric.fm/')
    expect(screen.getByRole('link', { name: 'Join the Discord' }).getAttribute('href')).toBe(SITE_LINKS.discordInvite)
  })

  it('an admin-set invite URL wins over the constant', async () => {
    state.invite = 'https://discord.gg/other'
    render(await Home({ searchParams: Promise.resolve({}) }))
    expect(screen.getByTestId('discord-invite').getAttribute('href')).toBe('https://discord.gg/other')
  })
})

describe('home page, signed in', async () => {
  const { default: Home } = await import('@/app/page')

  it('greeting, action cards first, then My music, then the condensed info and FAQ', async () => {
    state.viewer = member
    const { container } = render(await Home({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome back, Mia')
    const order = ['greeting', 'action-cards', 'my-music-card', 'before-you-upload', 'how-it-works', 'changing-a-song', 'faq', 'discord-invite'].map((id) =>
      container.querySelector(`[data-testid="${id}"]`),
    )
    order.forEach((el, i) => expect(el, String(i)).toBeTruthy())
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const l = uploadLimitsForUi(DEFAULT_CAPS)
    expect(screen.getByTestId('limits-short').textContent).toContain(l.text.mp3Short)
    expect(screen.getByTestId('limits-short').textContent).toContain(l.text.wavShort)
    expect(screen.getByTestId('changing-a-song').textContent).toContain('4 edits and 6 removals')
    expect(screen.getByTestId('changing-a-song').textContent).toContain('one edit and one removal request per song')
    expect(screen.getByTestId('faq').querySelectorAll('details')).toHaveLength(8)
    // No sign-in prompts for a member.
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull()
  })
})

describe('v0.4.1: SoundCloud links on the home page follow the kill switch', async () => {
  const { default: Home } = await import('@/app/page')
  const soundcloudText = () => document.body.textContent!.match(/SoundCloud/g)?.length ?? 0

  it('switch off: no SoundCloud mention anywhere (signed out or in)', async () => {
    render(await Home({ searchParams: Promise.resolve({}) }))
    expect(soundcloudText()).toBe(0)
    document.body.innerHTML = ''
    state.viewer = member
    render(await Home({ searchParams: Promise.resolve({}) }))
    expect(soundcloudText()).toBe(0)
  })

  it('switch on: glance, what you need, step 2, "We can’t take", the FAQ file answer and the Submit card say you can paste a link', async () => {
    state.sc = true
    render(await Home({ searchParams: Promise.resolve({}) }))
    expect(screen.getByTestId('at-a-glance').textContent).toContain('(or a SoundCloud link)')
    expect(screen.getByRole('heading', { name: 'What you’ll need' }).parentElement!.textContent).toContain('public SoundCloud track link')
    expect(screen.getByTestId('steps').textContent).toContain('Or paste a public SoundCloud track link')
    expect(screen.getByTestId('cant-take').textContent).toContain('or paste the song’s SoundCloud link')
    expect(document.querySelector('[data-faq="file"]')!.textContent).toContain('paste a public SoundCloud track link on the Submit page')
    document.body.innerHTML = ''
    state.viewer = member
    render(await Home({ searchParams: Promise.resolve({}) }))
    expect(document.querySelector('[data-action="submit"]')!.textContent).toContain('or paste a SoundCloud link')
  })
})

describe('v0.4.1: a signed-out visitor sent here from a portal page (?next=)', async () => {
  const { default: Home } = await import('@/app/page')

  it('says where signing in leads and carries the path in the sign-in form', async () => {
    render(await Home({ searchParams: Promise.resolve({ next: '/library?intent=remove' }) }))
    expect(screen.getByTestId('sign-in-next').textContent).toBe('Sign in with Discord to continue to ask for a song’s removal.')
    const form = screen.getByRole('button', { name: /sign in with discord/i }).closest('form')!
    expect((form.querySelector('input[name="next"]') as HTMLInputElement).value).toBe('/library?intent=remove')
  })

  it('ignores anything that is not a same-origin path', async () => {
    for (const next of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/']) {
      render(await Home({ searchParams: Promise.resolve({ next }) }))
      expect(screen.queryByTestId('sign-in-next')).toBeNull()
      expect(document.querySelector('input[name="next"]')).toBeNull()
      document.body.innerHTML = ''
    }
  })

  it('a signed-in visitor with ?next= goes straight there', async () => {
    state.viewer = member
    await expect(Home({ searchParams: Promise.resolve({ next: '/submit' }) })).rejects.toThrow('NEXT_REDIRECT /submit')
  })
})
