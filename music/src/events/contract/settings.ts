// EFM Events Portal — settings keys, defaults and validation (contract
// "Settings"). Stored in the existing `settings` table (one row per key);
// the default applies when a row is missing OR its value fails the key's
// schema, so a bad row can never widen a limit. Editable only by `manage`
// through GET/PUT /api/ev/admin/settings (server/admin/events-settings.ts).
//
// Pure: no DB access here. resolveEventsSettings() takes the raw rows.

import { z } from 'zod'

const GiB = 1024 * 1024 * 1024

export const PIN_STRATEGIES = ['overlap', 'overlap_weight', 'split_main'] as const
export type PinStrategy = (typeof PIN_STRATEGIES)[number]
export const ANNOUNCE_STRATEGIES = ['interrupt_rows', 'interrupt_weight'] as const
export type AnnounceStrategy = (typeof ANNOUNCE_STRATEGIES)[number]

const int = (min: number, max: number) => z.number().int().min(min).max(max)

// One schema per stored key. Upper bounds are hard ceilings (a `manage` user
// can lower a limit, never lift it past the plan's safety margins).
export const EVENTS_SETTING_SCHEMAS = {
  events_enabled: z.boolean(),
  events_autobuild_enabled: z.boolean(),
  events_uploads_enabled: z.boolean(),
  events_min_notice_h: int(0, 720),
  events_warn_notice_h: int(0, 720),
  events_member_max_hours: int(1, 72),
  events_member_horizon_days: int(1, 730),
  events_member_max_pending: int(0, 100),
  events_member_max_upcoming: int(0, 200),
  events_member_daily_creates: int(0, 100),
  events_gap_min: int(0, 240),
  events_freeze_min: int(0, 1440),
  events_max_rows: int(1, 500),
  events_audio_max_items: int(0, 200),
  // ≤ the shared 5 GB staging cap (DEFAULT_CAPS.maxStagingBytes).
  events_staging_budget_bytes: int(0, 5 * GiB),
  events_audio_unused_days: int(1, 365),
  events_pin_strategy: z.enum(PIN_STRATEGIES),
  events_announce_strategy: z.enum(ANNOUNCE_STRATEGIES),
  // < 180 s: the end kick must land before the watchdog's 3rd mismatch minute.
  events_end_wait_s: int(0, 170),
} as const

export type EventsSettingKey = keyof typeof EVENTS_SETTING_SCHEMAS
export const EVENTS_SETTING_KEYS = Object.keys(EVENTS_SETTING_SCHEMAS) as EventsSettingKey[]

export type EventsSettings = { [K in EventsSettingKey]: z.infer<(typeof EVENTS_SETTING_SCHEMAS)[K]> }

export const EVENTS_SETTING_DEFAULTS: EventsSettings = {
  events_enabled: false,
  events_autobuild_enabled: false,
  events_uploads_enabled: false,
  events_min_notice_h: 24,
  events_warn_notice_h: 48,
  events_member_max_hours: 24,
  events_member_horizon_days: 180,
  events_member_max_pending: 5,
  events_member_max_upcoming: 10,
  events_member_daily_creates: 10,
  events_gap_min: 10,
  events_freeze_min: 30,
  events_max_rows: 150,
  events_audio_max_items: 20,
  events_staging_budget_bytes: 1610612736,
  events_audio_unused_days: 14,
  events_pin_strategy: 'overlap',
  events_announce_strategy: 'interrupt_rows',
  events_end_wait_s: 90,
}

/** Full-object schema (GET response) and the strict partial patch (PUT body). */
export const EventsSettingsSchema = z.object(EVENTS_SETTING_SCHEMAS).strict()
export const EventsSettingsPatchSchema = EventsSettingsSchema.partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'empty patch')
export type EventsSettingsPatch = z.infer<typeof EventsSettingsPatchSchema>

export function isEventsSettingKey(key: string): key is EventsSettingKey {
  return Object.prototype.hasOwnProperty.call(EVENTS_SETTING_SCHEMAS, key)
}

export type SettingRow = { key: string; value: unknown }

/**
 * Resolve the effective events settings from raw `settings` rows (any keys;
 * non-events keys are ignored). A missing or invalid value falls back to the
 * default for that key. Cross-key rule: the warning threshold is never below
 * the minimum notice (warn := max(warn, min)).
 */
export function resolveEventsSettings(rows: Iterable<SettingRow> | Record<string, unknown>): EventsSettings {
  const out: Record<string, unknown> = { ...EVENTS_SETTING_DEFAULTS }
  const entries: Iterable<SettingRow> = Symbol.iterator in Object(rows)
    ? (rows as Iterable<SettingRow>)
    : Object.entries(rows as Record<string, unknown>).map(([key, value]) => ({ key, value }))
  for (const { key, value } of entries) {
    if (!isEventsSettingKey(key)) continue
    const r = EVENTS_SETTING_SCHEMAS[key].safeParse(value)
    if (r.success) out[key] = r.data
  }
  const s = out as EventsSettings
  if (s.events_warn_notice_h < s.events_min_notice_h) s.events_warn_notice_h = s.events_min_notice_h
  return s
}
