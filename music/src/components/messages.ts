// Human-readable text for every machine code the portal API returns, the
// probe's rejection codes, and item/batch/request statuses. Pure; shared by
// server and client components.

import { MAX_DURATION_MIN, MAX_MP3_UPLOAD_BYTES, MAX_UPLOAD_BYTES, mibOf, MIN_LADDER_BITRATE } from '@/lib/fit'

export const ERROR_TEXT: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again to continue.',
  forbidden: "You don't have permission to do that.",
  not_found: "That item doesn't exist, or you don't have access to it.",
  endpoint_missing: "This action isn't available on the server yet. Ask a portal admin.",
  rate_limited: "You're going a little fast. Wait a moment and try again.",
  csrf_origin: 'The request was blocked because it did not come from the portal. Reload the page and try again.',
  csrf_fetch_site: 'The request was blocked because it did not come from the portal. Reload the page and try again.',
  payload_too_large: 'That request is too large.',
  unsupported_media_type: 'The request was malformed. Reload the page and try again.',
  invalid_json: 'The request was malformed. Reload the page and try again.',
  internal: 'Something went wrong on the server. Try again in a minute.',
  network: "Couldn't reach the portal. Check your connection and try again.",
  unavailable: 'The portal is temporarily unavailable. Try again in a minute.',

  // batches / items
  state_changed: 'This changed while you were looking at it. Reload to see the latest status.',
  not_editable: 'This song can no longer be changed here: it has been decided, or its batch was already submitted.',
  batch_not_submitted: "This batch hasn't been submitted yet, so it can't be reviewed.",
  conflict: 'This changed while you were looking at it. Reload to see the latest status.',
  batch_not_draft: 'This batch has already been submitted, so files can no longer be added.',
  batch_full: 'This batch is full. Submit it, then start a new batch for more songs.',
  upload_not_available: 'That upload is no longer available. Remove it and upload the file again.',
  bad_upload_id: 'That upload is not valid. Remove it and upload the file again.',
  items_still_probing: 'Some files are still being checked. Wait until every file shows its details, then submit.',
  nothing_to_submit: 'There is nothing to submit yet. Add at least one file that passed the checks.',
  attestation_required: 'You must confirm the rights statement before submitting.',
  probe_unavailable: "The file checker is unavailable right now. Try adding the file again in a few minutes.",
  not_probed: "This file hasn't been checked yet, so there's no preview.",
  playlist_not_assignable: 'One of the chosen playlists is not allowed. Pick from the list.',
  invalid_decision: 'The decision was incomplete. A denial needs a reason.',
  invalid_comment: 'Comments cannot be empty, and must be under 2,000 characters.',
  item_not_in_batch: 'That song is not part of this batch.',

  // P4 requests, library and admin
  daily_cap: "You've reached today's limit for this kind of request. Try again tomorrow.",
  duplicate_request: 'You already have an open request for this song. Withdraw it first to file a different one.',
  no_change: 'Nothing would change: the proposed values are the same as the current ones.',
  invalid_request: 'The request is incomplete. Titles and artists cannot be blank, and a removal needs a reason.',
  invalid_edit: 'The edit is not valid. Titles and artists cannot be blank, and text cannot contain line breaks, tabs or invisible formatting characters.',
  invalid_playlists: 'The playlist selection is not valid.',
  invalid_archive: 'The archive request is not valid.',
  artist_not_active: "That artist isn't approved in the library yet. Approve the new artist first, or pick an existing artist.",
  not_archived: 'This song is no longer archived. Reload to see its status.',
  archive_in_progress: 'This song is being archived or restored. Wait until that finishes (or resolve it under Archived songs), then try again.',
  archive_job_pending: 'The worker is still working on this archive or restore. Wait a few minutes, then reload.',
  not_in_progress: 'This archive is no longer in progress. Reload to see its status.',
  unknown_setting: 'That setting does not exist on the server.',
  invalid_setting: 'That value is not allowed for this setting.',
  default_not_assignable: 'Default playlists must be among the assignable playlists.',
  binding_exists: 'That role already has this permission.',
  invalid_binding: 'Enter a Discord role id (17–20 digits) and choose review or manage.',

  // album art
  art_too_large: 'That image is larger than 5 MB.',
  art_type: 'Use a JPEG, PNG or WebP image.',
  art_rejected: "That image couldn't be used. Try a different JPEG, PNG or WebP file.",
  art_not_ready: 'The image is still being processed. Wait a moment and try again.',
  art_timeout: 'Processing the image took too long. Try again.',
  // POST /api/uploads/art refusals (server codes)
  unsupported_image_type: 'Use a JPEG, PNG or WebP image.',
  unreadable_image_header: "That image couldn't be read. Try a different JPEG, PNG or WebP file.",
  image_truncated: 'That image file is incomplete. Try saving it again.',
  image_too_large: 'That image is too large in pixels. Use one under 12 megapixels (at most 8000 px on a side).',
  exactly_one_art_field: 'Upload one image at a time.',
  empty_file: 'That image file is empty.',
  too_many_art_uploads_processing: 'A few images are still being processed. Wait a moment and try again.',
  art_upload_in_progress: 'Your previous image is still uploading. Wait for it to finish, then try again.',
  art_uploads_busy: 'Several images are uploading right now. Try again in a few seconds.',
  art_daily_quota: "You've reached today's limit for album art uploads. Try again tomorrow.",
  art_storage_full: 'Album art uploads are paused because the server is low on space. Try again later.',
  art_write_failed: "The image couldn't be saved. Try again in a minute.",
  body_timeout: 'The upload took too long. Check your connection and try again.',
  content_length_required: 'The upload was malformed. Reload the page and try again.',

  // uploads (tus)
  // No numbers: the per-file caps are admin-lowerable. The submit flow shows
  // the loaded limits through uploadErrorText.
  upload_too_large: 'That file is larger than the upload limit for MP3 files. (WAV files may be larger.)',
  wav_upload_too_large: 'That WAV file is larger than the WAV upload limit.',
  uploads_paused: 'Uploads are paused because the server is low on space. Try again later.',
  staging_full: 'Uploads are paused because the server is low on space. Try again later.',
  too_many_concurrent_uploads: 'You can upload 3 files at a time. The rest will start when these finish.',
  inflight_quota: 'You have too much uploading at once. Wait for some uploads to finish.',
}

// Per-action wording for a 409 race.
export const CONFLICT_TEXT = {
  decision: 'Someone else already decided this item. Reload to see what they chose.',
  withdraw: 'This song is no longer pending, so it cannot be withdrawn. Reload to see its status.',
  edit: 'This item changed while you were editing it (it may already have been decided). Reload to see the latest.',
  submit: 'This batch was already submitted. Reload to see its status.',
} as const

export const PROBE_ERROR_TEXT: Record<string, string> = {
  not_mp3: 'This is not a valid MP3 file.',
  not_single_mp3_stream: 'This file must contain exactly one MP3 audio stream.',
  unexpected_streams: 'This file contains extra streams that are not allowed.',
  bitrate_too_low: 'The bitrate is too low. Upload at least 128 kbps.',
  too_short: 'The song is shorter than 30 seconds.',
  too_long: `The song is longer than ${MAX_DURATION_MIN} minutes, the most that fits even when converted down to ${MIN_LADDER_BITRATE / 1000} kbps.`,
  no_duration: "The file's length could not be read.",
  id3_too_large: 'The embedded tags or cover art are too large (over 5 MB).',
  ffprobe_timeout: 'Checking the file took too long. The file may be damaged.',
  ffprobe_unparseable: 'The file could not be read. It may be damaged.',
  metadata_timeout: 'Reading the tags took too long. The file may be damaged.',
  metadata_unparseable: "The file's tags could not be read.",
  input_size: 'The file is empty or larger than the upload limit.',
  mp3_too_large: `MP3 files can be at most ${mibOf(MAX_MP3_UPLOAD_BYTES)} MB.`,
  // Fit-to-size re-encode of a too-big MP3 (v0.3.2)
  reencode_timeout: 'Converting the MP3 down to fit took too long. Try again later, or upload a smaller MP3.',
  reencode_failed: "The MP3 couldn't be converted down to fit. Export it again, or upload a smaller MP3.",
  reencode_invalid: "The MP3 couldn't be converted to a valid smaller MP3. Export it again, or upload a smaller MP3.",
  reencoded_too_large: `The converted MP3 would still be larger than ${mibOf(MAX_UPLOAD_BYTES)} MB. Upload a shorter song.`,
  bad_id3_header: "The file's ID3 tag header is damaged.",
  id3_compressed_frame: "The file's tags use compressed frames, which are not accepted. Re-save the tags without compression.",
  id3_encrypted_frame: "The file's tags contain encrypted frames, which are not accepted.",
  publish_mismatch: 'The file check failed. Upload the file again.',
  // WAV uploads (v0.3.0)
  not_wav: 'This is not a valid WAV file.',
  wav_too_large: 'This WAV file is larger than the WAV upload limit.',
  wav_rf64_unsupported: 'RF64 / BW64 WAV files are not supported. Export a standard WAV or an MP3.',
  wav_unsupported: 'This kind of WAV file (big-endian RIFX) is not supported. Export a standard WAV or an MP3.',
  wav_codec_unsupported:
    'This WAV file is compressed or uses an unusual format (for example ADPCM or MP3 inside a WAV). Export it as uncompressed PCM (16-, 24- or 32-bit, or 32/64-bit float), or as an MP3.',
  wav_channels: 'WAV files can have 1 to 8 channels.',
  wav_sample_rate: 'The WAV sample rate must be between 8 kHz and 192 kHz.',
  wav_bad_riff: "The WAV file's header is damaged. Export it again.",
  wav_bad_fmt: "The WAV file's format header is damaged or inconsistent. Export it again.",
  wav_bad_data: 'The WAV file has no valid audio section. Export it again.',
  wav_no_audio: 'The WAV file contains no audio.',
  wav_truncated: 'The WAV file is incomplete: its size does not match its header. Export or upload it again.',
  wav_trailing_data: 'The WAV file has unexpected data after its end. Export it again.',
  wav_unfinalized:
    "This WAV file's header was never finished (its sizes are unset, as in a file recorded live or written to a pipe). Open it in your audio editor and export it again as a normal WAV.",
  wav_bad_chunk: 'The WAV file is damaged (an invalid section header). Export it again.',
  wav_too_many_chunks: 'The WAV file has too many extra sections. Export it again without extra metadata.',
  wav_chunk_too_large: 'The WAV file contains an extra metadata section over 16 MB. Export it again without it.',
  wav_bad_list: "The WAV file's tag section (LIST/INFO) is damaged or larger than 1 MB.",
  wav_bad_id3: "The WAV file's ID3 tag section is damaged.",
  wav_not_single_stream: 'The WAV file must contain exactly one audio stream.',
  wav_header_mismatch: "The WAV file's header does not match its audio. Export it again.",
  wav_too_long: `WAV files can be at most ${MAX_DURATION_MIN} minutes long, the most that fits even when converted down to ${MIN_LADDER_BITRATE / 1000} kbps.`,
  convert_timeout: 'Converting the WAV to MP3 took too long. Try again later, or upload an MP3.',
  convert_failed: "The WAV couldn't be converted to MP3. Export it again, or upload an MP3.",
  convert_invalid: "The WAV couldn't be converted to a valid MP3. Export it again, or upload an MP3.",
  converted_too_large: `The converted MP3 would be larger than ${mibOf(MAX_UPLOAD_BYTES)} MB. Upload a shorter song.`,
  input_size_mismatch: 'The upload was incomplete. Upload the file again.',
  input_missing: 'The upload could not be found. Upload the file again.',
  input_not_regular: 'The upload could not be read. Upload the file again.',
  spool_unavailable: 'The file checker was unavailable. Upload the file again.',
  bad_probe_result: 'The file check failed. Upload the file again.',
  wrong_result_source: 'The file check failed. Upload the file again.',
  probe_failed: 'The file check failed. Upload the file again.',
  interrupted: 'The file check was interrupted by a server restart. Upload the file again.',
}

export function probeErrorText(code: string | null | undefined): string {
  if (!code) return 'The file was rejected.'
  return PROBE_ERROR_TEXT[code] ?? `The file was rejected (${code}).`
}

// tus refusals with the loaded per-file caps (bytes), which an admin may
// have lowered below the defaults.
export function uploadErrorText(code: string, status: number | undefined, limits: { mp3: number; wav: number }): string {
  const mb = (n: number) => Math.round(n / 1024 / 1024)
  if (code === 'upload_too_large') return `That file is larger than ${mb(limits.mp3)} MB, the limit for MP3 files. (WAV files can be up to ${mb(limits.wav)} MB.)`
  if (code === 'wav_upload_too_large') return `That WAV file is larger than the ${mb(limits.wav)} MB limit for WAV files.`
  return errorText(code, status)
}

export function errorText(code: string, status?: number): string {
  if (ERROR_TEXT[code]) return ERROR_TEXT[code]
  if (status === 409) return ERROR_TEXT.state_changed!
  if (status && status >= 500) return ERROR_TEXT.internal!
  return `The request failed (${code}).`
}

export type ChipTone = 'neutral' | 'pending' | 'progress' | 'live' | 'bad' | 'muted'

export const ITEM_STATUS: Record<string, { label: string; tone: ChipTone; help: string }> = {
  probing: { label: 'Checking file', tone: 'progress', help: 'The file is being checked.' },
  rejected: { label: 'Rejected file', tone: 'bad', help: 'The file did not pass the checks.' },
  draft: { label: 'Draft', tone: 'neutral', help: 'Not submitted yet.' },
  pending: { label: 'Pending review', tone: 'pending', help: 'Waiting for a manager.' },
  approved: { label: 'Approved', tone: 'progress', help: 'Approved; queued for the station.' },
  applying: { label: 'Ingesting', tone: 'progress', help: 'Being added to the station.' },
  verifying: { label: 'Verifying', tone: 'progress', help: 'Checking the station copy.' },
  live: { label: 'Live', tone: 'live', help: 'In rotation on EuphoricFM.' },
  denied: { label: 'Denied', tone: 'bad', help: 'A manager declined this song.' },
  withdrawn: { label: 'Withdrawn', tone: 'muted', help: 'You withdrew this song.' },
  failed: { label: 'Failed', tone: 'bad', help: 'Adding it to the station failed; managers have been alerted.' },
  ingest_failed: { label: 'Ingest failed', tone: 'bad', help: 'Adding it to the station failed; managers have been alerted.' },
}

export const BATCH_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  submitted: { label: 'Submitted', tone: 'pending' },
  completed: { label: 'Completed', tone: 'live' },
  closed: { label: 'Closed', tone: 'muted' },
  withdrawn: { label: 'Withdrawn', tone: 'muted' },
}

export const REQUEST_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  pending: { label: 'Pending review', tone: 'pending' },
  approved: { label: 'Approved', tone: 'progress' },
  applying: { label: 'Applying', tone: 'progress' },
  verifying: { label: 'Verifying', tone: 'progress' },
  done: { label: 'Done', tone: 'live' },
  denied: { label: 'Denied', tone: 'bad' },
  withdrawn: { label: 'Withdrawn', tone: 'muted' },
  failed: { label: 'Failed', tone: 'bad' },
}

export const FOLDER_ERROR_TEXT: Record<string, string> = {
  empty_component: 'Nothing is left after removing the characters folders cannot use.',
  empty_folder: 'The folder name is empty.',
  folder_separator: 'Folder names cannot contain slashes.',
  folder_control_char: 'Folder names cannot contain control characters.',
  folder_dot: 'Folder names cannot start with a dot.',
  folder_too_long: 'The folder name is too long.',
}
