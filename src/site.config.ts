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

    // The one synced range selection (primary row + Listeners/Plays cards'
    // own rows, and the "since {date}" tile/top-list subs below) shares this
    // single label map and aria-label — see stats.ts renderRangeTabs().
    rangeLabels: { '7d': '7D', '30d': '30D', '90d': '90D', '1y': '1Y', all: 'ALL' },
    rangeAriaLabel: 'Time range',

    // "since {date}" — reused verbatim by the ranged KPI tile subs, the
    // top-list card subs, and (prefixed with rhythm.allTimePrefix) the
    // Rhythm card's caption. Lowercase by design — it always follows other
    // words ("last year", card titles) except the chart captions below,
    // which use the capitalized caption.all variant instead.
    since: 'since {date}',

    kpi: {
      plays: {
        label: 'Total plays',
        // 'all' range only — every other range uses rangeSub below instead.
        sub: 'since {date}',
        rangeSub: {
          '7d': 'last 7 days',
          '30d': 'last 30 days',
          '90d': 'last 90 days',
          '1y': 'last year',
        },
      },
      peakListeners: {
        label: 'Peak listeners',
        sub: '{date}',
        // Shown instead of the {date} sub when every day in the selected
        // range has a null lmax (no listener samples landed in that window).
        noData: 'No listener data yet',
      },
      tracks: { label: 'Tracks played', sub: '{count} artists' },
      requests: { label: 'Requests played', sub: '{pct}% of plays' },
    },

    // Coverage captions under every chart (between the chart and its table
    // twin): ranged windows get the exact rendered day span; 'all' gets this
    // capitalized variant (distinct from the lowercase `since` above, which
    // reads naturally after other words instead of starting a line).
    caption: {
      rangeSeparator: ' – ',
      all: 'Since {date}',
    },

    listeners: {
      title: 'Listeners',
      ariaLabel: 'Listener count over time',
      tableTime: 'Time',
      tableAvg: 'Avg',
      tableMax: 'Peak',
    },

    plays: {
      title: 'Plays',
      ariaLabel: 'Plays over time',
      perDay: 'per day',
      perWeek: 'per week',
      tableDate: 'Date',
      tablePlays: 'Plays',
    },

    rhythm: {
      title: 'Rhythm',
      ariaLabel: 'Listening rhythm heatmap by day and hour, station time',
      tabs: { plays: 'Plays', listeners: 'Listeners' },
      // Rhythm stays all-time regardless of the synced range — this prefix
      // makes that explicit right in the subtitle.
      allTimePrefix: 'All-time · ',
      // stats.ts appends the actual short tz abbreviation (derived from
      // meta.timezone, e.g. "EDT") in parens after this — never hardcode
      // one here, STATS_TZ is operator-configurable.
      subtitlePlays: 'Plays by hour & day, station time',
      subtitleListeners: 'Average listeners by hour & day, station time',
      byHour: 'By hour',
      byDay: 'By day',
      // Cell percentage basis: plays = share of all plays; listeners = share
      // of the single peak hour/day cell. {pct} is 1dp for plays, whole
      // number for listeners — see stats.ts pctLabel()/pctShort().
      pctOfPlays: '{pct}% of all plays',
      pctOfPeak: '{pct}% of the peak hour',
      // Per-cell tooltip label lines. {day}/{hour} are filled from the
      // day-of-week/hour-of-day lookup tables, never a timezone-aware Date.
      tooltipCell: '{day} · {hour} · station time',
      tooltipHour: '{hour} · station time',
      tooltipDay: '{day} · station time',
      tableDay: 'Day',
      tableHour: 'Hour',
      tableValue: 'Value',
      tablePct: '%',
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

  // Euphoric FM Events — public /events page (src/pages/events.astro +
  // EventsHero/EventsHowItWorks/EventsServices/EventStatus/EventInquiryModal).
  // EVERY user-visible string those components render comes from here, same
  // discipline as `stats` above. Discord payload copy (username, embed title/
  // color/footer) stays inline in EventInquiryModal.astro's script — same
  // pattern ContactModal.astro already uses for its own webhook copy.
  events: {
    title: 'Events',
    description:
      'Bring Euphoric FM to your next event — curated music and radio programming for grand openings, private parties, car meets, club nights, and more.',

    hero: {
      eyebrow: 'EUPHORIC FM EVENTS',
      heading: 'Bring Euphoric FM to your next event.',
      body: "Whether you're planning a grand opening, private party, car meet, club night, community gathering, or something entirely your own, Euphoric FM can help give your event its own sound. Work with our team to create curated music and radio programming tailored to your event.",
      ctaPlan: 'Plan Your Event',
      ctaListen: 'Listen to Euphoric FM',
    },

    howItWorks: {
      title: 'How It Works',
      steps: [
        {
          n: 1,
          title: 'Tell Us About Your Event',
          body: "Send us the details — what you're planning, when, and where. No detail is too small to include.",
        },
        {
          n: 2,
          title: 'We Build the Sound',
          body: "Our team puts together curated music and radio programming that matches the mood you're going for.",
        },
        {
          n: 3,
          title: 'Tune In',
          body: 'Set up Euphoric FM radios throughout your venue and let the programming carry the night.',
        },
      ],
    },

    services: {
      title: 'Your Event. Your Sound.',
      items: [
        {
          title: 'Curated Music',
          body: 'Hand-picked tracks that match the mood and pace of your event, start to finish.',
        },
        {
          title: 'Event Radio Programming',
          body: 'A dedicated programming block built around your event — not just a playlist on shuffle.',
        },
        {
          title: 'Announcements',
          body: 'On-air shoutouts and updates woven into the broadcast — schedule changes, specials, whatever guests need to hear.',
        },
        {
          title: 'Venue-Wide Radio',
          body: 'Set up Euphoric FM radios throughout your venue so the sound follows guests wherever they go.',
        },
        {
          title: 'Live Changes',
          body: "Want to shift the mood mid-event? We'll accommodate changes where practical.",
        },
      ],
    },

    goodFor: {
      title: 'Good For',
      items: [
        'Grand Openings',
        'Club Nights',
        'Private Parties',
        'Car Meets',
        'Business Events',
        'Community Events',
        'Special Events',
      ],
    },

    // EventStatus.astro — the future-dynamic "what's on right now" area.
    // `current` is null today (renders the polished empty state below); the
    // ACTIVE shape is fully typed so a later runtime fetch can hydrate the
    // evst-* nodes without any component changes. No backend, no polling yet.
    status: {
      title: 'Happening Now',
      offAir: {
        pill: 'OFF AIR',
        heading: 'Nothing on the calendar right now.',
        body: "Euphoric FM Events isn't currently broadcasting for an event. Planning something? Let's change that.",
        cta: 'Plan Your Event',
      },
      onAir: {
        pill: 'ON AIR',
      },
      current: null as null | {
        name: string;
        venue: string;
        startsAt: string;
        endsAt: string;
        description: string;
        imageUrl?: string;
        status: string;
        listenUrl?: string;
      },
    },

    // Euphoric Events station (`event` shortcode) public schedule feed —
    // unauthenticated, CORS-open (verified: access-control-allow-origin: *),
    // same trust level as the main station's nowplaying poll. No API key, no
    // Caddyfile change (connect-src already allows https://euphoric.fm).
    // Read by scripts/events.ts to drive EventStatus.astro's on-air card +
    // "On the Calendar" list — ignored entirely while status.current above is
    // set (manual override wins; see events.ts's data-override bail).
    station: {
      apiBase: 'https://euphoric.fm/api',
      stationId: 'event',
      publicPlayerUrl: 'https://euphoric.fm/public/event',
      timezone: 'America/New_York',
      scheduleRows: 20,
      pollMs: 60000,
    },

    // "On the Calendar" — the upcoming-events list under the status card,
    // populated by events.ts from the schedule feed above.
    calendar: {
      title: 'On the Calendar',
      listen: 'Listen Live',
      today: 'Today',
      tomorrow: 'Tomorrow',
    },

    inquiry: {
      button: 'Send Inquiry',
      title: 'Plan an Event with Euphoric FM',
      intro:
        "Tell us what you're planning and what you'd like Euphoric FM to bring to it. You don't need to have every detail figured out yet.",
      eventTypes: [
        'Grand Opening',
        'Nightlife & Club',
        'Private Party',
        'Car Meet',
        'Business Event',
        'Community Event',
        'Other',
      ],
      attendancePlaceholder: 'e.g., 30–50 guests',
      atmospherePlaceholder: 'High energy, relaxed, upscale, throwback, party, background music…',
      announcementsPlaceholder: 'Anything we should announce or promote during the broadcast?',
      success: "Thanks! Your event inquiry was sent — we'll be in touch.",
      webhookMissing: 'Inquiries are temporarily disabled — webhook not configured.',
    },
  },
} as const;
