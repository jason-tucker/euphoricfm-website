export const site = {
  name: 'EuphoricFM',
  tagline: 'San Andreas pop, all day.',
  description:
    'EuphoricFM is the pop radio station of San Andreas — current hits, rising local artists, listener requests.',
  url: 'https://info.euphoric.fm',

  azuracast: {
    apiBase: 'https://euphoric.fm/api',
    stationId: 'euphoricfm',
    streamUrl: 'https://euphoric.fm/listen/euphoricfm/radio.mp3',
  },

  realtime: {
    mode: 'poll' as 'poll' | 'sse',
    pollMs: 5000,
  },

  // Webhook URLs are NEVER hardcoded or build-time inlined. They're served at
  // runtime by Caddy from `/runtime-config.js`, which templates them out of the
  // container's env vars (see Caddyfile + docker-compose.yml). The modals read
  // them off `window.__EFM_CONFIG__.discord.{requestWebhook,contactWebhook}`.
  discord: {
    avatarUrl: 'https://euphoric.fm/static/android-chrome-192x192.png',
  },

  aboutText: `EuphoricFM was born from a passion for the infectious rhythms and melodies that define the pop genre. Founded in 2023 by a group of dedicated music enthusiasts, we set out to create a platform that not only celebrates the biggest hits but also shines a spotlight on emerging talent from our very own city.

San Andreas is not only our home; it's also the source of incredible talent waiting to be discovered. EuphoricFM takes pride in promoting local artists, and featuring interviews with rising stars from the city's music scene. We believe in giving a voice to the voices that make our city's pop culture unique.`,

  businessAd: {
    price: '$8,000 / month',
    perks: [
      'Premium ad placement on-air',
      'Ad-breaks every 6 songs',
      'Optional "brought to you by" mention',
      'Average of 120,000 listeners per day',
      'Option to rotate ad out for holiday specials or deals as requested',
    ],
    note: 'Use "Contact us!" to inquire and get started.',
  },

  // NewDayRP profile URL pattern — used to validate the optional profile field
  // on the contact form (mirrors the existing AzuraCast button behaviour).
  newDayRpProfilePattern: '^https?://(www\\.)?newdayrp\\.com/members/\\d+/?$',
} as const;
