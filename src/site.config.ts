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

  // Live DJ broadcasts are ALWAYS special events for this station, so the UI
  // treats `live.is_live` from AzuraCast as a big deal (banner, ON AIR pill,
  // indeterminate bar). Every string around that state is editable here.
  // `fallbackName` covers a broadcast where AzuraCast reports no streamer name.
  liveEvents: {
    eyebrow: 'Special Event',
    pill: 'ON AIR',
    idlePill: 'AUTO DJ', // pill text when the stream runs on autopilot (no live DJ)
    label: 'Live Broadcast', // replaces the "Now Playing" eyebrow during events
    tagline: 'Live special event — happening right now on EuphoricFM.',
    fallbackName: 'EuphoricFM Live',
    elapsedPrefix: 'LIVE', // shown before broadcast elapsed in the times row
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

  // Station Stats section (src/components/Stats.astro + src/scripts/stats.ts).
  // EVERY user-visible string the section renders comes from here — stats.ts
  // imports this module directly (it's build-time bundled, unlike the webhook
  // URLs). "{date}"/"{count}"/"{pct}" tokens are filled in by stats.ts.
  stats: {
    heading: 'Station Stats',
    tagline: 'The story of EuphoricFM, in numbers.',
    // Coverage line: "{prefix} {date}" — never overstates how far back the
    // sidecar's data actually goes (meta.coverage.from), so there are two
    // variants depending on whether backfill has reached the station's
    // founding month.
    coveragePrefixFull: 'All-time · since',
    coveragePrefixPartial: 'Tracking since',

    kpi: {
      plays: { label: 'Total plays', sub: 'since {date}' },
      peakListeners: { label: 'Peak listeners', sub: '{date}' },
      tracks: { label: 'Tracks played', sub: '{count} artists' },
      requests: { label: 'Requests played', sub: '{pct}% of all plays' },
    },

    listeners: {
      title: 'Listeners',
      ariaLabel: 'Listener count over time',
      tabs: { '24h': '24H', '7d': '7D', '30d': '30D', all: 'ALL' },
      tableTime: 'Time',
      tableAvg: 'Avg',
      tableMax: 'Peak',
    },

    plays: {
      title: 'Plays',
      ariaLabel: 'Plays over time',
      tabs: { '30d': '30D', '90d': '90D', '1y': '1Y', all: 'ALL' },
      perDay: 'per day',
      perWeek: 'per week',
      tableDate: 'Date',
      tablePlays: 'Plays',
    },

    rhythm: {
      title: 'Rhythm',
      ariaLabel: 'Listening rhythm by time of day',
      tabs: { hour: 'By hour', day: 'By day' },
      // stats.ts appends the actual short tz abbreviation (derived from
      // meta.timezone, e.g. "EDT") in parens after this — never hardcode
      // one here, STATS_TZ is operator-configurable.
      subtitleListenersHour: 'Average listeners by hour, station time',
      subtitleListenersDay: 'Average listeners by day, station time',
      subtitlePlaysHour: 'Plays by hour, station time',
      subtitlePlaysDay: 'Plays by day, station time',
      tableHour: 'Hour',
      tableDay: 'Day',
      tableValue: 'Value',
    },

    topTracks: { title: 'Top Tracks' },
    topArtists: { title: 'Top Artists', tracksSuffix: 'tracks' },

    showMore: 'Show more',
    viewTable: 'View as table',
    notEnoughData: 'Not enough data yet',

    detail: {
      close: 'Close',
      back: 'Back',
      plays: 'Plays',
      requests: 'Requests',
      firstPlayed: 'First played',
      lastPlayed: 'Last played',
      playsPerMonth: 'Plays per month',
      topTracks: 'Top tracks',
      tracksSuffix: 'tracks',
      loadError: 'Failed to load — try again later.',
      tableMonth: 'Month',
      tablePlays: 'Plays',
    },
  },
} as const;
