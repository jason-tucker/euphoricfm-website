# music-fetch — SoundCloud import for the EFM Music Portal (plan §3.6, P5).
#
# Build (context = this directory):
#   docker build -t efm-music-fetch .                   # runtime image (last stage)
#   docker build --target test -t efm-music-fetch:test .
#   docker run --rm --read-only --tmpfs /tmp --cap-drop ALL \
#     --security-opt no-new-privileges:true --network none efm-music-fetch:test
#
# Pins: the base image by DIGEST (multi-arch index) and yt-dlp by version +
# sha256 in requirements.txt. Bump both monthly (README.md).

ARG PYTHON_IMAGE=python:3.13-alpine@sha256:79e7a9b9ff1cbceff819f856fb374477792a5967759d94df266de7b7b4120e6f

# ---------------------------------------------------------------- base ----
FROM ${PYTHON_IMAGE} AS base
# uid/gid 1000 matches the portal's spool/staging ownership (music-init).
RUN addgroup -S -g 1000 fetch \
 && adduser -S -D -H -u 1000 -G fetch -h /tmp -s /sbin/nologin fetch
COPY requirements.txt /tmp/requirements.txt
COPY fetchsvc/ /tmp/src/fetchsvc/
RUN set -eu; \
    python -m pip install --no-cache-dir --disable-pip-version-check --no-deps \
        --require-hashes --only-binary=:all: -r /tmp/requirements.txt; \
    site="$(python -c 'import sysconfig; print(sysconfig.get_path("purelib"))')"; \
    cp -r /tmp/src/fetchsvc "$site/fetchsvc"; \
    python -m compileall -q "$site/fetchsvc"; \
    python -m pip uninstall -y -q pip; \
    rm -rf /tmp/requirements.txt /tmp/src /root/.cache; \
    python -I -c 'import fetchsvc.__main__, yt_dlp.version as v; print("yt-dlp", v.__version__)'

# ---------------------------------------------------------------- test ----
FROM base AS test
COPY tests/ /app/tests/
USER 1000:1000
WORKDIR /tmp
CMD ["python", "-I", "-B", "-m", "unittest", "discover", "-v", "-s", "/app/tests", "-t", "/app"]

# ------------------------------------------------------------- runtime ----
FROM base AS runtime
USER 1000:1000
WORKDIR /tmp
# No ENV, no secrets, no config by environment: flags only.
ENTRYPOINT ["python", "-I", "-B", "-m", "fetchsvc"]
