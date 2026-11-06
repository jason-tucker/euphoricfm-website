"""Error codes written to /spool/fetch/out/<uuid>.json as `errorCode`.

The first eight are the plan's contract (EFM Music Portal plan §3.6 / P5
brief). The rest are fetch-internal additions, documented in README.md,
for failures the contract list does not name.
"""

BAD_URL = 'bad_url'                    # not an accepted SoundCloud track/shortlink URL
NOT_A_TRACK = 'not_a_track'            # SoundCloud URL, but a set/playlist/likes/user page/...
REDIRECT_HOST = 'redirect_host'        # shortlink redirected off the SoundCloud host allowlist
TOO_LARGE = 'too_large'                # media over the 60 MiB cap
TOO_LONG = 'too_long'                  # info-JSON duration over 24 minutes (the portal cap)
TIMEOUT = 'timeout'                    # yt-dlp (10 min) or shortlink resolution timed out
EXTRACTOR_FAILED = 'extractor_failed'  # yt-dlp failed / produced unusable output
ARTWORK_HOST = 'artwork_host'          # artwork URL not https://*.sndcdn.com

# Additions (see README.md "Error codes").
BAD_REQUEST = 'bad_request'            # malformed spool request / duplicate uuid
BAD_MEDIA = 'bad_media'                # downloaded file failed the magic-byte allowlist
INTERRUPTED = 'interrupted'            # service stopped mid-job (SIGTERM or crash recovery)
INTERNAL = 'internal'                  # unexpected exception inside fetch
PREVIEW_ONLY = 'preview_only'          # 0.2.1: SoundCloud offers only a 30 s preview (Go+ track)

CONTRACT_CODES = frozenset({
    BAD_URL, NOT_A_TRACK, REDIRECT_HOST, TOO_LARGE, TOO_LONG, TIMEOUT,
    EXTRACTOR_FAILED, ARTWORK_HOST,
})
ALL_CODES = CONTRACT_CODES | {BAD_REQUEST, BAD_MEDIA, INTERRUPTED, INTERNAL, PREVIEW_ONLY}


class FetchError(Exception):
    """A job failure that maps to exactly one error code."""

    def __init__(self, code: str, detail: str = ''):
        if code not in ALL_CODES:
            raise ValueError(f'unknown error code {code!r}')
        super().__init__(f'{code}: {detail}' if detail else code)
        self.code = code
        self.detail = detail
