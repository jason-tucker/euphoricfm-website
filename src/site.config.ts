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

  // Web Player page (/player/, src/pages/player.astro + scripts/player.ts).
  player: {
    title: 'Web Player',
    description:
      'Listen to EuphoricFM live in your browser — now playing, up next, song history and requests.',
    // Pop-out window (opened from the "Pop out" button). Sized for the compact
    // strip layout; the page also switches to it for any viewport ≤ 420×260.
    popout: { name: 'efm-player', width: 360, height: 200 },
    historyTitle: 'Song history',
    // Shown instead of an ad / station-imaging row (blank tags, or one of the
    // excluded playlists below).
    breakTitle: 'Station break',
    breakArtist: 'EuphoricFM',
    // Shown on the home card and /player/ while the station's API cannot be
    // reached (network error, timeout, 5xx); the poller keeps retrying.
    offline: 'Station offline — retrying',
    // Toast when the browser refuses to start the stream.
    playFailed: 'Couldn’t start the stream. Try again in a moment.',
    // Mirrors DEFAULT_EXCLUDE_PLAYLISTS in server/stats.mjs (ads + imaging);
    // test/site-build.test.mjs fails if the two lists drift apart.
    excludePlaylists: ['2Ads', '3EFM/Free Ads', '5Local Ads', 'Go Vote', '4EuphoricFM'],
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
  // them off `window.__EFM_CONFIG__.contact.webhook` (a neutral key: the built
  // info pages never say "Discord", by owner decision).
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

  // One-page home (src/pages/index.astro, Release 4). Every string the home
  // sections render lives here. Owner rules: radio first, no team section,
  // and no mention of Discord anywhere on info.euphoric.fm
  // (test/site-build.test.mjs fails if it creeps back in).
  home: {
    hero: {
      eyebrow: 'Live from San Andreas · 24/7',
      sub: 'Current hits, rising local artists and your requests — on EuphoricFM.',
      request: 'Request a song',
      webPlayer: 'Web Player',
      ways: 'Ways to listen',
    },
    // One sidebar card with two tabs (SongsCard.astro): Recently played is
    // selected by default; the Requested tab carries the pending count.
    songs: {
      tabsLabel: 'Songs',
      recent: 'Recently played',
      requested: 'Requested',
      history: 'Song history',
      empty: 'No requests right now',
      offline: 'Recently played is back when the station is.',
      button: 'Request a song',
    },
    // Up next row on the player card (PlayerCard.astro). The next song shows
    // for the whole of the current one; these lines fill the same fixed-height
    // row when there is no song to show.
    upNext: {
      label: 'Up Next',
      choosing: 'Choosing the next song…',
      stationBreak: 'Station break next',
      live: 'Back to the playlist after the live set',
      offline: 'Back when the station is',
    },
    about: {
      eyebrow: 'About',
      // Live facts from the stats sidecar (/stats/summary). A fact with no
      // data is hidden, never shown as 0.
      facts: {
        since: 'on air since',
        listens: 'listens all-time',
        tracks: 'tracks by {artists} artists',
        tracksPlain: 'tracks played',
        requests: 'listener requests played',
        peak: 'peak listeners · {date}',
        peakPlain: 'peak listeners',
        always: '24/7',
        alwaysSub: 'auto DJ, around the clock',
      },
      source: 'Live from the station’s stats',
      seeStats: 'See all stats',
      musicCta: 'Get your music on air',
    },
    events: {
      eyebrow: 'EuphoricFM Events',
      heading: 'Bring EuphoricFM to your next event.',
      body: 'Grand openings, private parties, car meets, club nights — our team builds the sound and runs it live on the Euphoric Events station.',
      goodFor: 'Good for:',
      learn: 'Learn about events',
      statusTitle: 'Happening now',
      offAirBody: 'When an event is on air, it shows up here with a Listen live button.',
      calendarTitle: 'On the calendar',
      calendarEmpty: 'No upcoming events yet.',
    },
    music: {
      eyebrow: 'For artists',
      heading: 'Get your music on EuphoricFM',
      lede: 'Local artist? Send your songs through the Music Portal. Station managers listen to every one.',
      submit: 'Submit music',
      steps: [
        { title: 'Sign in to the portal', body: 'Artists from the EuphoricFM community sign in at music.euphoric.fm.' },
        { title: 'Upload your songs', body: 'MP3 or WAV. We convert WAVs for broadcast; the portal shows the current limits.' },
        { title: 'Managers review', body: 'Station managers listen to every song. If one isn’t a fit, you get a reason.' },
        { title: 'On air', body: 'Approved songs join the rotation. Follow each one on My music.' },
      ],
      already: 'Already on the station?',
      fix: 'Fix a song’s info or cover',
      or: 'or',
      remove: 'ask to remove a song',
      // Portal library with the matching intent banner (music/src/app/library).
      fixPath: 'library?intent=edit',
      removePath: 'library?intent=remove',
    },
    ways: {
      eyebrow: 'Ways to listen',
      heading: 'Listen anywhere',
      here: { title: 'Right here', body: 'Press play at the top of this page — on a computer or the in-game phone.', button: 'Play live' },
      player: { title: 'Web Player', body: 'Just the player, sized to any window. Pop it out and keep listening while you do other things.', open: 'Open', popout: 'Pop out' },
      app: { title: 'Your music app', body: 'VLC, foobar2000, iTunes or Winamp — open our playlist file.' },
      direct: { title: 'Direct stream', body: 'The live MP3 stream, for anything that plays internet radio.', copy: 'Copy', copied: 'Copied', copyFailed: 'Press Ctrl+C' },
    },
    stats: {
      eyebrow: 'Station stats',
      heading: 'EuphoricFM in numbers',
      topTracksHint: 'Tap a song for its history',
      topArtistsHint: 'Tap an artist for their songs',
      showFull: 'Show full stats — listens, rhythm, top 50',
      hideFull: 'Show fewer stats',
      unavailable: 'Station stats are taking a break. Check back in a few minutes.',
    },
    contact: {
      eyebrow: 'Contact',
      heading: 'Get in touch',
      contact: { title: 'Contact us', body: 'Questions, shout-outs, interview requests or feedback — send the team a message.', button: 'Contact us' },
      advertise: { title: 'Advertise your business', body: 'Premium on-air placement, ad breaks every 6 songs and an optional “brought to you by” mention.', button: 'See ad details' },
      event: { title: 'Book an event', body: 'Tell us what you’re planning. You don’t need every detail figured out yet.', button: 'Plan your event' },
    },
    faq: {
      eyebrow: 'FAQ',
      heading: 'Questions people ask',
      // Plain text; "{portal}" becomes a link to the Music Portal.
      items: [
        {
          q: 'How do I request a song?',
          a: 'Press Request a song under the player, search the station library and pick a track. Requests join the queue and usually play within a few songs — you can see what’s waiting on the Requested tab next to the player.',
        },
        {
          q: 'Can I listen on my in-game phone?',
          a: 'Yes. Open info.euphoric.fm in your phone’s browser and press play. The page is built for the phone and switches to a lighter look there automatically.',
        },
        {
          q: 'Why does the title change a moment before the song does?',
          a: 'The song info updates the moment a track starts on our server, but your player keeps a few seconds of audio in reserve so it never stutters. The title can switch a few seconds before you hear the new song; the music catches up on its own.',
        },
        {
          q: 'How do I get my own music played?',
          a: 'Send your songs through the {portal}. Station managers listen to every submission, and approved songs join the rotation. You can follow each one on My music.',
        },
        {
          q: 'How do I advertise my business?',
          a: 'Open Advertise your business above to see the ad package, then send us a message with Contact us and we’ll get your spot on the air.',
        },
        {
          q: 'Who runs EuphoricFM?',
          a: 'A small team of San Andreas music lovers who started the station in 2023. They pick the rotation, review artist submissions and run the special events. To reach them, use Contact us.',
        },
      ],
      portalLabel: 'Music Portal',
    },
    footer: {
      blurb: 'San Andreas pop, all day. Current hits, rising local artists and your requests.',
      listen: 'Listen',
      station: 'Station',
      music: 'Music',
      contact: 'Contact',
    },
  },

  // Music submission portal (music.euphoric.fm) — the portal's home (FAQ
  // link, #music library links); info.euphoric.fm/music(/…) 302s here (see
  // the Caddyfile's "Music portal entry" block). No in-game special-casing.
  // Every "Submit music" button goes to the upload page instead:
  // shared/nav.json origins.portal + musicMenu.submit.path.
  music: {
    portalUrl: 'https://music.euphoric.fm/',
    button: 'Submit music',
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

    // The one synced range selection (primary row + Listeners/Listens cards'
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

    // "Listens" = each song play weighted by the listeners tuned in when it
    // started (ads excluded) — see server/stats.mjs's module header. The
    // API keeps its `plays`/`p` field names; only the copy says listens.
    kpi: {
      plays: {
        label: 'Total listens',
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
      // {pct} = requested songs ÷ songs played (raw counts), not ÷ listens.
      requests: { label: 'Requests played', sub: '{pct}% of songs played' },
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
      ariaLabel: 'Peak listeners over time',
      tableTime: 'Time',
      tableAvg: 'Avg',
      tableMax: 'Peak',
    },

    plays: {
      title: 'Listens',
      ariaLabel: 'Listens over time',
      perDay: 'per day',
      perWeek: 'per week',
      tableDate: 'Date',
      tablePlays: 'Listens',
    },

    rhythm: {
      title: 'Rhythm',
      ariaLabel: 'Listening rhythm heatmap by day and hour, station time',
      tabs: { plays: 'Listens', listeners: 'Listeners' },
      // Rhythm stays all-time regardless of the synced range — this prefix
      // makes that explicit right in the subtitle.
      allTimePrefix: 'All-time · ',
      // stats.ts appends the actual short tz abbreviation (derived from
      // meta.timezone, e.g. "EDT") in parens after this — never hardcode
      // one here, STATS_TZ is operator-configurable.
      subtitlePlays: 'Listens by hour & day, station time',
      subtitleListeners: 'Average listeners by hour & day, station time',
      byHour: 'By hour',
      byDay: 'By day',
      // Cell percentage basis: listens = share of all listens; listeners =
      // share of the single peak hour/day cell. {pct} is 1dp for listens,
      // whole number for listeners — see stats.ts pctLabel()/pctShort().
      pctOfPlays: '{pct}% of all listens',
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
      plays: 'Listens',
      requests: 'Requests',
      firstPlayed: 'First played',
      lastPlayed: 'Last played',
      playsPerMonth: 'Listens per month',
      topTracks: 'Top tracks',
      tracksSuffix: 'tracks',
      loadError: 'Failed to load — try again later.',
      tableMonth: 'Month',
      tablePlays: 'Listens',
    },
  },

  // EuphoricFM Events — public /events page (src/pages/events.astro +
  // EventsHero/EventsHowItWorks/EventsServices/EventStatus) and the home
  // page's "Plan an event" pop-up (EventInquiryModal, `inquiry` below).
  // EVERY user-visible string those components render comes from here, same
  // discipline as `stats` above. Discord payload copy (username, embed title/
  // color/footer) stays inline in EventInquiryModal.astro's script — same
  // pattern ContactModal.astro already uses for its own webhook copy.
  events: {
    title: 'Events',
    description:
      'Bring EuphoricFM to your next event — curated music and radio programming for grand openings, private parties, car meets, club nights, and more.',

    hero: {
      eyebrow: 'EuphoricFM Events',
      heading: 'Bring EuphoricFM to your next event.',
      body: "Whether you're planning a grand opening, private party, car meet, club night, community gathering, or something entirely your own, EuphoricFM can help give your event its own sound. Work with our team to create curated music and radio programming tailored to your event.",
      ctaListen: 'Listen to EuphoricFM',
    },

    howItWorks: {
      title: 'How it works',
      steps: [
        {
          n: 1,
          title: 'Tell us about your event',
          body: "Send us the details — what you're planning, when, and where. No detail is too small to include.",
        },
        {
          n: 2,
          title: 'We build the sound',
          body: "Our team puts together curated music and radio programming that matches the mood you're going for.",
        },
        {
          n: 3,
          title: 'Tune in',
          body: 'Set up EuphoricFM radios throughout your venue and let the programming carry the night.',
        },
      ],
    },

    services: {
      title: 'Your event, your sound.',
      items: [
        {
          title: 'Curated music',
          body: 'Hand-picked tracks that match the mood and pace of your event, start to finish.',
        },
        {
          title: 'Event radio programming',
          body: 'A dedicated programming block built around your event — not just a playlist on shuffle.',
        },
        {
          title: 'Announcements',
          body: 'On-air shoutouts and updates woven into the broadcast — schedule changes, specials, whatever guests need to hear.',
        },
        {
          title: 'Venue-wide radio',
          body: 'Set up EuphoricFM radios throughout your venue so the sound follows guests wherever they go.',
        },
        {
          title: 'Live changes',
          body: "Want to shift the mood mid-event? We'll accommodate changes where practical.",
        },
      ],
    },

    goodFor: {
      title: 'Good for',
      items: [
        'Grand openings',
        'Club nights',
        'Private parties',
        'Car meets',
        'Business events',
        'Community events',
        'Special events',
      ],
    },

    // EventStatus.astro — the future-dynamic "what's on right now" area.
    // `current` is null today (renders the polished empty state below); the
    // ACTIVE shape is fully typed so a later runtime fetch can hydrate the
    // evst-* nodes without any component changes. No backend, no polling yet.
    status: {
      title: 'Happening now',
      offAir: {
        pill: 'OFF AIR',
        heading: 'Nothing on the calendar right now.',
        body: "EuphoricFM Events isn't broadcasting for an event right now. When one goes live, it shows up here.",
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

    // events.euphoric.fm — where requests, the calendar and event radio live.
    // pages/events.astro sends top-level visitors there (never out of an
    // iframe: the in-game phone can't load it, so /events/ explains events
    // there instead). `noscript`/`label` are the low-key no-JS fallback link.
    portal: {
      url: 'https://events.euphoric.fm/',
      noscript: 'Event requests and the calendar are at',
      label: 'events.euphoric.fm',
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
      title: 'On the calendar',
      listen: 'Listen live',
      today: 'Today',
      tomorrow: 'Tomorrow',
    },

    inquiry: {
      button: 'Send inquiry',
      title: 'Plan an event with EuphoricFM',
      intro:
        "Tell us what you're planning and what you'd like EuphoricFM to bring to it. You don't need to have every detail figured out yet.",
      eventTypes: [
        'Grand opening',
        'Nightlife & club',
        'Private party',
        'Car meet',
        'Business event',
        'Community event',
        'Other',
      ],
      attendancePlaceholder: 'e.g., 30–50 guests',
      atmospherePlaceholder: 'High energy, relaxed, upscale, throwback, party, background music…',
      announcementsPlaceholder: 'Anything we should announce or promote during the broadcast?',
      success: "Thanks! Your event inquiry was sent — we'll be in touch.",
      webhookMissing: 'Inquiries are temporarily unavailable — please try again later.',
    },
  },
} as const;
