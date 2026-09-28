// Home page FAQ. Every answer describes what the portal actually does (see
// the code references); numbers come from the limits helper and settings.

import type { UiUploadLimits } from '@/server/ui/limits'

export type FaqContext = {
  limits: UiUploadLimits
  requestCaps: { edit: number; removal: number }
  autoCloseDays: number
}

export type FaqEntry = { id: string; q: string; a: string }

export function faqEntries({ limits: l, requestCaps, autoCloseDays }: FaqContext): FaqEntry[] {
  return [
    {
      // submissions.ts submitBatch → ticket job; review decisions; ingest.
      id: 'review',
      q: 'How does review work?',
      a:
        'Submitting a batch opens a ticket in our Discord. A manager listens to every song, can ask you questions in the ticket, ' +
        'then approves or declines each song. Approved songs are added to the station and go into rotation. ' +
        'While a song is still pending review you can withdraw it from My music.',
    },
    {
      // Tickets open with the submitter as opener (bot mentions the opener); decision and ingest posts
      // (handlers.ts ticketDecision, scheduler/tickets.ts); member comments relayed as the author (handlers.ts ticketComment).
      id: 'ticket',
      q: 'Who gets notified in the Discord ticket?',
      a:
        'The ticket is opened for you, and the ticket bot mentions you when it opens, so Discord notifies you. ' +
        'The managers’ questions, every decision (with the reason for a decline) and an “Added to the station” message for each song are posted there. ' +
        'Comments you write on your batch in the portal are copied into the ticket under your name.',
    },
    {
      // probe.ts (MP3 rules), wav.ts (WAV rules and conversion).
      id: 'file',
      q: 'Which file should I upload?',
      a: `An MP3 (${l.text.mp3Quality}, ${l.text.mp3Size}) or a WAV (${l.text.wavSize}). ${l.note} Other formats such as ${l.text.refusedShort} are refused: export an MP3 or WAV first.`,
    },
    {
      // Probe rejections are shown on the file card (messages.ts PROBE_ERROR_TEXT).
      id: 'rejected',
      q: 'Why was my file rejected?',
      a:
        `Every file is checked as soon as it uploads, and the reason shows on the file. We can’t take ${l.text.tooLong} ` +
        `We also refuse MP3s under ${l.minKbps} kbps and files that aren’t a real MP3 or WAV. Fix the file and upload it again.`,
    },
    {
      // A denial needs a reason (invalid_decision); shown in My music and posted to the ticket.
      id: 'declined',
      q: 'What happens if my song is declined?',
      a:
        'A manager has to give a reason for every decline. You see it next to the song in My music and in your Discord ticket. ' +
        'A declined song is not added to the station. If anything is unclear, ask in the ticket.',
    },
    {
      // No SLA anywhere; ingest is paced (caps.ingestPerHour); ticket auto-close (auto_close_days).
      id: 'how-long',
      q: 'How long does review take?',
      a:
        'It depends on the managers: they review batches as they have time, so there is no fixed wait. ' +
        'Approved songs are added to the station a few at a time, so a song can take a little longer to reach the air. ' +
        `Once every song in a batch is decided, its ticket closes after ${autoCloseDays} days without activity.`,
    },
    {
      // requests/service.ts: one open request per song, daily caps, one ticket each.
      id: 'edits',
      q: 'How do I fix a song’s info or get a song removed?',
      a:
        'Find the song in the Library and choose Suggest edit (title, artist, album, genre or cover art) or Request removal (with a short reason). ' +
        'Each request opens its own Discord ticket, and a manager checks it before anything changes on the station. ' +
        `You can have one open request per song, and file up to ${requestCaps.edit} edit and ${requestCaps.removal} removal requests a day. Follow them under My music.`,
    },
    {
      // Approved removals archive the file (worker/requests/jobs.ts archiveMedia); /library/archived needs `manage`.
      id: 'archived',
      q: 'Who can see a song after it’s removed?',
      a:
        'An approved removal takes the song off the station and moves it to an archive; it is not deleted. ' +
        'Archived songs no longer appear in the Library. Only the station managers can see them, and they can put one back.',
    },
  ]
}
