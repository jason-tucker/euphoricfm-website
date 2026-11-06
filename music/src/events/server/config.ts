// GET /api/ev/config: the public numbers the events UI shows and checks
// against (the server enforces them again in rules.ts).

import type { z } from 'zod'
import { loadEventsSettings } from '../../server/admin/events-settings'
import type { DB } from '../../server/db/client'
import { loadCaps } from '../../server/settings'
import { DEFAULT_CAPS } from '../../server/settings-defaults'
import { MAX_MP3_UPLOAD_BYTES, MAX_WAV_UPLOAD_BYTES } from '../../server/spool/protocol'
import { MAX_DURATION_S } from '../../lib/fit'
import type { ConfigResponse } from '../contract/api'
import { EVENTS_ANNOUNCEMENT_MIN_DURATION_S, EVENTS_SONG_MIN_DURATION_S, NOWPLAYING_URL, STATION_LISTEN_URL } from '../contract/rules'

export async function eventsConfig(db: DB): Promise<z.infer<typeof ConfigResponse>> {
  const [s, caps] = await Promise.all([loadEventsSettings(db), loadCaps(db)])
  return {
    eventsEnabled: s.events_enabled,
    uploadsEnabled: s.events_uploads_enabled,
    autobuildEnabled: s.events_autobuild_enabled,
    minNoticeH: s.events_min_notice_h,
    warnNoticeH: s.events_warn_notice_h,
    memberMaxHours: s.events_member_max_hours,
    horizonDays: s.events_member_horizon_days,
    maxPending: s.events_member_max_pending,
    maxUpcoming: s.events_member_max_upcoming,
    gapMin: s.events_gap_min,
    freezeMin: s.events_freeze_min,
    maxRows: s.events_max_rows,
    audioMaxItems: s.events_audio_max_items,
    endWaitS: s.events_end_wait_s,
    chunkBytes: Math.min(caps.chunkBytes, DEFAULT_CAPS.chunkBytes),
    caps: {
      mp3Bytes: Math.min(caps.maxMp3UploadBytes, MAX_MP3_UPLOAD_BYTES),
      wavBytes: Math.min(caps.maxWavUploadBytes, MAX_WAV_UPLOAD_BYTES),
      maxDurationS: MAX_DURATION_S,
      // The events probe runs with PROBE_MIN_DURATION_S = the announcement
      // minimum; songs under 30 s are rejected after the probe (worker).
      minDurationS: EVENTS_ANNOUNCEMENT_MIN_DURATION_S,
      minDurationByKind: { song: EVENTS_SONG_MIN_DURATION_S, announcement: EVENTS_ANNOUNCEMENT_MIN_DURATION_S },
    },
    stationListenUrl: STATION_LISTEN_URL,
    nowPlayingUrl: NOWPLAYING_URL,
  }
}
