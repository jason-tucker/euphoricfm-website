// v0.4.1: share metadata. Portal links are pasted into Discord tickets, so
// they get a proper embed: a page that sets its own openGraph replaces the
// layout's entirely (Next merges metadata shallowly), hence one helper.

export const SITE_NAME = 'EuphoricFM Music Portal'
// The station's share card, served by the info site.
export const OG_IMAGE = { url: 'https://info.euphoric.fm/images/og.png', width: 1200, height: 630, alt: 'EuphoricFM' }

export function openGraph(title: string, description: string, url?: string) {
  return { siteName: SITE_NAME, type: 'website' as const, title, description, ...(url ? { url } : {}), images: [OG_IMAGE] }
}
