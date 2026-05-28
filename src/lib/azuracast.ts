// AzuraCast public API types and helpers for EuphoricFM.
//
// The "now playing" endpoint is unauthenticated and returns the live song,
// listener count, and the last ~15 history entries. The "requests" endpoint
// returns the requestable library; each entry has a `request_url` we POST to
// in order to enqueue a listener request.

export interface AzuraSong {
  id: string;
  text: string;
  artist: string;
  title: string;
  album: string;
  genre: string;
  art: string;
  isrc: string;
  lyrics: string;
}

export interface AzuraNowPlayingEntry {
  sh_id: number;
  played_at: number; // unix seconds
  duration: number; // seconds
  is_request: boolean;
  playlist: string;
  streamer: string;
  song: AzuraSong;
  elapsed?: number; // present on the live entry only
  remaining?: number;
}

export interface AzuraNowPlayingResponse {
  station: { id: number; name: string; shortcode: string; description: string };
  listeners: { current: number; unique: number; total: number };
  live: { is_live: boolean; streamer_name: string; broadcast_start: number | null };
  now_playing: AzuraNowPlayingEntry;
  playing_next: AzuraNowPlayingEntry | null;
  song_history: AzuraNowPlayingEntry[];
  is_online: boolean;
  cache: string;
}

export interface AzuraRequestable {
  request_id: string;
  request_url: string;
  song: AzuraSong;
}

export function nowPlayingUrl(apiBase: string, stationId: string): string {
  return `${apiBase}/nowplaying/${stationId}`;
}

export function requestsUrl(apiBase: string, stationId: string, search?: string): string {
  const u = new URL(`${apiBase}/station/${stationId}/requests`);
  if (search) u.searchParams.set('searchPhrase', search);
  return u.toString();
}

// `request_url` from the requests endpoint is a relative path
// (e.g. /api/station/1/request/<id>); join it to the AzuraCast host.
export function absoluteRequestUrl(apiBase: string, requestUrl: string): string {
  if (/^https?:\/\//.test(requestUrl)) return requestUrl;
  const host = new URL(apiBase).origin;
  return host + requestUrl;
}
