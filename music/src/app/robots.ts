import type { MetadataRoute } from 'next'

// v0.4.1: backs the pages' noindex meta for crawlers that read robots.txt
// first. The home page stays fetchable (share embeds in Discord).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', disallow: ['/api/', '/review', '/admin', '/dashboard', '/submit', '/batches/', '/requests/'] },
  }
}
