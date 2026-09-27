"""The ONLY place fetch touches its own environment.

music-fetch has no secrets and must never see any (plan §3: `env: none`).
At startup the service refuses to run if its environment holds any variable
outside a small allowlist of names Docker and the python base image set.
Only variable NAMES are inspected and only names are ever printed — values
are never read into the program.

The yt-dlp child gets a fixed, constructed environment ({PATH, HOME=/tmp}),
never a copy of os.environ.
"""

from __future__ import annotations

import os

# Names Docker / the python:alpine base image / a shell may set. None of them
# can carry a secret by convention; GPG_KEY is the base image's PUBLIC Python
# release-signing key fingerprint.
ALLOWED_NAMES = frozenset({
    'PATH', 'HOME', 'HOSTNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
    'PYTHON_VERSION', 'PYTHON_SHA256', 'GPG_KEY',
    'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED',
})

CHILD_PATH = '/usr/local/bin:/usr/bin:/bin'


def unexpected_env_names() -> list[str]:
    return sorted(k for k in os.environ.keys() if k not in ALLOWED_NAMES)


def child_env(home: str) -> dict[str, str]:
    """The complete environment for the yt-dlp child. Built from constants."""
    return {'PATH': CHILD_PATH, 'HOME': home}
