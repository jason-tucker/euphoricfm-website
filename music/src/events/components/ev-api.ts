// The events site reuses the portal's client fetch helper (same-origin
// fetch; the browser adds Origin + Sec-Fetch-Site for the CSRF gate) and adds
// readable text for the events API's error codes.

import { api, ApiError, messageFor } from '@/components/api'

export { api, ApiError }

export const EV_ERROR_TEXT: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again to continue.',
  forbidden: "You don't have permission to do that.",
  not_found: "That event doesn't exist, or you don't have access to it.",
  events_disabled: 'Event requests are not open yet. Check back soon, or ask the EuphoricFM team in Discord.',
  uploads_disabled: 'Uploads are switched off right now. You can still use songs from the radio library and our announcement set.',
  too_soon: 'Events must start at least 24 hours from now.',
  min_notice: 'Events must start at least 24 hours from now.',
  too_long: 'That event is longer than members can book.',
  max_length: 'That event is longer than members can book.',
  too_far: "That date is too far ahead. Pick a date inside the booking window.",
  horizon: "That date is too far ahead. Pick a date inside the booking window.",
  bad_range: 'The event must end after it starts.',
  overlap: 'That time clashes with another event (events need a short gap between them). Pick another time.',
  clash: 'That time clashes with another event (events need a short gap between them). Pick another time.',
  max_pending: 'You already have the most requests waiting for review. Wait for a decision, or withdraw one.',
  max_upcoming: 'You already have the most upcoming approved events.',
  daily_cap: "You've created the most requests allowed today. Try again tomorrow.",
  daily_creates: "You've created the most requests allowed today. Try again tomorrow.",
  frozen: 'This event starts soon, so it can no longer be changed here. Ask in your ticket.',
  not_editable: "This event can't be changed any more.",
  state_changed: 'This event changed while you were looking at it. Reload to see the latest.',
  conflict: 'This event changed while you were looking at it. Reload to see the latest.',
  duplicate_track: 'That song is already in the playlist.',
  duplicate: 'That song is already in the playlist.',
  pin_out_of_range: 'A pinned song must be inside the event and at least 15 minutes before it ends.',
  bad_pin: 'A pinned song must be inside the event and at least 15 minutes before it ends.',
  bad_announcement: 'An announcement time is outside the event, or not on the 5-minute grid.',
  too_many_rows: 'This playlist needs too many schedule entries. Remove some pinned songs or announcements, or space them out.',
  max_rows: 'This playlist needs too many schedule entries. Remove some pinned songs or announcements, or space them out.',
  nightly_restart: 'Nothing can be scheduled between 1:55 and 2:05 AM ET: the station restarts then.',
  empty_playlist: 'Add at least one song before you submit.',
  nothing_to_submit: 'Add at least one song before you submit.',
  media_not_allowed: "One of the songs isn't available any more. Remove it and pick another.",
  audio_not_ready: "One of your uploads isn't ready yet. Wait until it shows Ready.",
  audio_limit: "You've reached the limit for My audio. Delete an old upload first.",
  audio_in_use: 'That upload is part of an upcoming event, so it cannot be deleted now.',
  staging_full: 'Upload space is full right now. Try again later.',
  invalid_reason: 'A reason is required.',
  reason_required: 'A reason is required.',
  invalid_body: 'Something in the form is not valid. Check the fields and try again.',
  invalid: 'Something in the form is not valid. Check the fields and try again.',
}

/** The sentence shown for an error from the events API. */
export function evMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const t = EV_ERROR_TEXT[err.code]
    if (t) return err.issues.length ? `${t} (${err.issues.join('; ')})` : t
  }
  return messageFor(err)
}
