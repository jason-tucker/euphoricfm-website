# Dependency & SBOM Notes — euphoricfm-website

## Direct dependencies (package.json)

| Package | Range | Role |
|---|---|---|
| `astro` | `^6.3.8` | static site generator (**build-time only**) |
| `@astrojs/tailwind` | `^6.0.2` | dev — Tailwind integration |
| `tailwindcss` | `^3.4.19` | dev — CSS |

The `efm-requests` service (`server/index.mjs`) has **zero npm dependencies** —
it uses only Node built-ins (`node:http`, `node:fs`, `node:path`, `node:url`,
global `fetch`). Its Dockerfile installs nothing.

## Key risk-reducing fact: the runtime has no npm surface

This is a **static** Astro site. After `pnpm build`, the production artefact is
plain HTML/CSS/JS served by Caddy; **none of the ~938 transitively-resolved npm
packages run in production**. They are a build-time concern only. The two
runtime processes are Caddy (Go) and the zero-dep Node service. This dramatically
shrinks the supply-chain blast radius compared to a typical SSR/Node app.

## Vulnerability scan

```
$ pnpm audit            → No known vulnerabilities found
$ pnpm audit --prod     → No known vulnerabilities found
```
A `pnpm audit --audit-level=high` gate now runs in CI (`security.yml`).

## Licenses
Spot-check of the resolved tree shows permissive licenses only
(MIT / Apache-2.0 / BSD-2/3-Clause / BlueOak-1.0.0 / ISC). No GPL/AGPL/copyleft
or "unlicensed" packages surfaced. `pnpm audit --audit-level=high` (CI gate) + Dependabot catch any future
addition with a known vuln; `dependency-review-action` can be re-added for
license/PR gating once the repo's Dependency Graph feature is enabled.

## Lifecycle-script / postinstall risk
- Dockerfile build already used `pnpm install --frozen-lockfile --ignore-scripts`.
- CI build install **now also** uses `--ignore-scripts` (was missing → fixed),
  so a malicious dependency postinstall cannot execute in CI.
- `pnpm-lock.yaml` is committed and installs are `--frozen-lockfile` (no drift).

## Base images
- Site image: `caddy:2.10-alpine` (pinned minor) ← multi-stage from `node:24-alpine`.
- Requests image: `node:24-alpine`.
- Watchtower: `nickfedor/watchtower:latest` (third-party fork on a floating tag —
  noted; consider pinning to a digest).

## Generating a formal SBOM
Not produced inline (no SBOM tool in the review env), but trivially generated:
```
npx @cyclonedx/cyclonedx-npm --output-file sbom.json     # CycloneDX (npm tree)
# or, against the built images:
syft ghcr.io/jason-tucker/euphoricfm-website:latest -o cyclonedx-json
trivy image ghcr.io/jason-tucker/euphoricfm-website:latest
```
Recommend wiring `syft`/`trivy image` into `build-and-publish.yml` to attach an
SBOM + image-vuln report as build artefacts (follow-up).
