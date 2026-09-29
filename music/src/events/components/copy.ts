// Editable copy for the events site, seeded from the info site's Events page
// (src/site.config.ts `events`). Pages read their words from here.

export const EV_COPY = {
  hero: {
    eyebrow: 'EuphoricFM Events',
    heading: 'Bring EuphoricFM to your next event.',
    body: "Whether you're planning a grand opening, private party, car meet, club night, community gathering, or something entirely your own, EuphoricFM can help give your event its own sound. Pick the songs, schedule your announcements, and we'll put it on air on EuphoricFM Event Radio.",
    ctaRequest: 'Request an event',
    ctaHow: 'How it works',
    ctaListen: 'Listen to Event Radio',
  },
  howItWorks: {
    title: 'How it works',
    steps: [
      { n: 1, title: 'Tell us about your event', body: "Sign in with Discord and send the details: what you're planning, when, and where." },
      { n: 2, title: 'Build the sound', body: 'Pick songs from the EuphoricFM library, pin favourites to a time, and add announcements or your own audio.' },
      { n: 3, title: 'We review it', body: 'Every request opens a ticket in our Discord. The team checks it, asks if anything is unclear, and approves it.' },
      { n: 4, title: 'Tune in', body: 'Your event airs on EuphoricFM Event Radio. Set up radios around your venue and let the programming carry the night.' },
    ],
  },
  services: {
    title: 'Your event, your sound.',
    items: [
      { title: 'Curated music', body: 'Hand-picked tracks from the EuphoricFM library that match the mood and pace of your event, start to finish.' },
      { title: 'Event radio programming', body: 'A dedicated programming block built around your event, played in your order or shuffled.' },
      { title: 'Announcements', body: 'Shoutouts and updates at set times or on a repeat: schedule changes, specials, whatever guests need to hear.' },
      { title: 'Venue-wide radio', body: 'Set up EuphoricFM radios throughout your venue so the sound follows guests wherever they go.' },
      { title: 'Your own audio', body: 'Upload your own announcements or songs and reuse them for your next event.' },
    ],
  },
  goodFor: {
    title: 'Good for',
    items: ['Grand openings', 'Club nights', 'Private parties', 'Car meets', 'Business events', 'Community events', 'Special events'],
  },
  site: {
    title: 'How this site works',
    items: [
      { title: 'Calendar', body: 'Every booked slot is on the calendar. Public events show their details; private events show only "Booked · Private event"; requests waiting for review show "Pending".' },
      { title: 'Request', body: 'Sign in with Discord (you need to be in the EuphoricFM Discord server), fill in the request, build the playlist and submit.' },
      { title: 'My events', body: 'Follow your requests, open the Discord ticket, make changes or withdraw a request.' },
      { title: 'Listen', body: 'Event Radio plays here and on EuphoricFM radios in the city. Between events it plays the EuphoricFM Events loop.' },
    ],
  },
  offAir: "Off air — you're hearing the EFM Events loop",
  privateNowPlaying: "Private events stay private on this site, but while one is on air, the station's now-playing shows the title of each song.",
} as const
