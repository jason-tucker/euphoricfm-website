// Readable labels for event enums. Pure; shared by server and client components.

import type { ChipTone } from '@/components/messages'
import type { EventStatus, EventType } from '@/events/contract/types'

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  grand_opening: 'Grand opening',
  club_night: 'Club night',
  private_party: 'Private party',
  car_meet: 'Car meet',
  business: 'Business event',
  community: 'Community event',
  special: 'Special event',
  other: 'Other',
}

export const EVENT_STATUS: Record<EventStatus, { label: string; tone: ChipTone; help: string }> = {
  draft: { label: 'Draft', tone: 'muted', help: 'Not sent yet. Finish the request and submit it.' },
  pending: { label: 'Pending', tone: 'pending', help: 'Waiting for the EuphoricFM team to review it. The time slot is held for you.' },
  approved: { label: 'Approved', tone: 'live', help: 'Approved. The team will set it up on Event Radio before it starts.' },
  built: { label: 'Ready to air', tone: 'live', help: 'Set up on Event Radio and ready to go.' },
  live: { label: 'On air', tone: 'bad', help: 'On air now on Event Radio.' },
  ended: { label: 'Ended', tone: 'muted', help: 'This event has finished.' },
  denied: { label: 'Declined', tone: 'bad', help: 'The team declined this request. The reason is in your ticket.' },
  withdrawn: { label: 'Withdrawn', tone: 'muted', help: 'You withdrew this request.' },
  cancelled: { label: 'Cancelled', tone: 'bad', help: 'Cancelled by the EuphoricFM team. Details are in your ticket.' },
  expired: { label: 'Expired', tone: 'muted', help: 'Nobody reviewed it in time, so the request expired.' },
  failed: { label: 'Needs attention', tone: 'bad', help: 'Setting it up on Event Radio failed. The team has been told.' },
}

export const statusOf = (s: string) => EVENT_STATUS[s as EventStatus] ?? { label: s, tone: 'neutral' as ChipTone, help: '' }
