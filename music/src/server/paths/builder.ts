// The ONE place station-media paths are built and asserted (plan §3.5).
//
// `root` is '' in production and PORTAL_TEST_PREFIX (e.g. 'Portal-Test/') in
// the prefix profile; every pattern is anchored on it, so a prefix-profile
// path can never name a real Music/ or Removed/ location and vice versa.
//
// P0d-B: AzuraCast stores the POST path verbatim and does NOT reject `..`,
// so these assertions and the wrapper's prefix guard are the only barrier.

export class PathError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'PathError'
  }
}

const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u
const DISALLOWED = /[^\p{L}\p{N} \-_.,'()&!]/gu
export const MAX_COMPONENT_BYTES = 150

export const TEST_PREFIX_RE = /^Portal-Test[A-Za-z0-9-]*\/$/

export function assertRoot(root: string): void {
  if (root !== '' && !TEST_PREFIX_RE.test(root)) throw new PathError('bad_root', `invalid path root ${JSON.stringify(root)}`)
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function patterns(root: string) {
  assertRoot(root)
  const r = escapeRe(root)
  return {
    ingest: new RegExp(`^${r}Music/Artists/[^/]+/[^/]+\\.mp3$`),
    artistDir: new RegExp(`^${r}Music/Artists/[^/]+$`),
    archiveDir: new RegExp(`^${r}Removed/\\d+$`),
    // archive + artist-move SOURCES, and restore TARGETS (any extension)
    artistFile: new RegExp(`^${r}Music/Artists/[^/]+/[^/]+$`),
    restoreSource: new RegExp(`^${r}Removed/\\d+/[^/]+$`),
    // Portal-visible library surface (search, requests): Music/Artists/**
    librarySurface: new RegExp(`^${r}Music/Artists/.+`),
  }
}

function utf8Bytes(s: string) {
  return Buffer.byteLength(s, 'utf8')
}

function truncateBytes(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s
  let out = ''
  for (const ch of s) {
    if (utf8Bytes(out + ch) > max) break
    out += ch
  }
  return out
}

// Generic structural assertions on any full path, before every write/move.
export function assertSafePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) throw new PathError('empty')
  if (path.includes('\0') || CONTROL.test(path)) throw new PathError('control_char')
  if (path.includes('\\')) throw new PathError('backslash')
  if (path.startsWith('/')) throw new PathError('absolute')
  if (path.includes('://')) throw new PathError('scheme')
  if (path !== path.normalize('NFC')) throw new PathError('not_nfc')
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new PathError('bad_segment')
  }
}

// Existing folder names come verbatim from artists.folder (hand-chosen names
// like `Aaron "Spirit" Michaels` stay as they are) but are still refused if
// they could change the directory structure.
export function assertExistingFolder(folder: string): string {
  if (typeof folder !== 'string' || folder.length === 0) throw new PathError('empty_folder')
  if (folder.includes('/') || folder.includes('\\')) throw new PathError('folder_separator')
  if (folder.includes('\0') || CONTROL.test(folder)) throw new PathError('folder_control_char')
  if (folder === '.' || folder === '..' || folder.startsWith('.')) throw new PathError('folder_dot')
  if (utf8Bytes(folder) > 255) throw new PathError('folder_too_long')
  return folder
}

// New folder names / file-name parts: NFC → allowlist → collapse → trim →
// strip leading dots → ≤150 bytes.
export function sanitizeComponent(raw: string): string {
  let s = String(raw ?? '').normalize('NFC')
  s = s.replace(DISALLOWED, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[.\s]+/, '')
  s = truncateBytes(s, MAX_COMPONENT_BYTES).trim()
  // Leading dots are already stripped, so '.'/'..' reduce to ''.
  if (s === '') throw new PathError('empty_component')
  return s
}

export function newArtistFolder(artistName: string): string {
  return assertExistingFolder(sanitizeComponent(artistName))
}

// `<Artist> - <Title>` (+ ` (n)` for collisions) + `.mp3`, base ≤150 bytes.
export function ingestFileName(artist: string, title: string, collisionIndex = 1): string {
  if (!Number.isInteger(collisionIndex) || collisionIndex < 1 || collisionIndex > 9) throw new PathError('bad_collision_index')
  const suffix = collisionIndex === 1 ? '' : ` (${collisionIndex})`
  const base = truncateBytes(`${sanitizeComponent(artist)} - ${sanitizeComponent(title)}`, MAX_COMPONENT_BYTES - utf8Bytes(suffix)).trim()
  const name = `${base}${suffix}.mp3`
  if (name.startsWith('.') || name.includes('/')) throw new PathError('bad_file_name')
  return name
}

export function buildIngestPath(root: string, folder: string, fileName: string): string {
  const p = `${root}Music/Artists/${assertExistingFolder(folder)}/${fileName}`
  assertIngestPath(root, p)
  return p
}

export function assertIngestPath(root: string, path: string): string {
  assertSafePath(path)
  if (!patterns(root).ingest.test(path)) throw new PathError('ingest_pattern')
  return path
}

export function artistDirPath(root: string, folder: string): string {
  const p = `${root}Music/Artists/${assertExistingFolder(folder)}`
  assertSafePath(p)
  if (!patterns(root).artistDir.test(p)) throw new PathError('artist_dir_pattern')
  return p
}

// Artist-move destination: the directory must name an ACTIVE artist folder.
export function assertArtistMoveTarget(root: string, dir: string, activeFolders: ReadonlySet<string>): string {
  assertSafePath(dir)
  if (!patterns(root).artistDir.test(dir)) throw new PathError('artist_dir_pattern')
  const folder = dir.slice(`${root}Music/Artists/`.length)
  if (!activeFolders.has(folder)) throw new PathError('artist_not_active')
  return dir
}

export function archiveDirPath(root: string, mediaId: number): string {
  if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw new PathError('bad_media_id')
  const p = `${root}Removed/${mediaId}`
  if (!patterns(root).archiveDir.test(p)) throw new PathError('archive_pattern')
  return p
}

export function assertArchiveDir(root: string, dir: string): string {
  assertSafePath(dir)
  if (!patterns(root).archiveDir.test(dir)) throw new PathError('archive_pattern')
  return dir
}

// Archive + artist-move SOURCE: an existing file under an artist folder; any
// existing extension (m4a / wav files exist and are allowed).
export function assertArtistFileSource(root: string, path: string): string {
  assertSafePath(path)
  if (!patterns(root).artistFile.test(path)) throw new PathError('source_pattern')
  return path
}

// Restore SOURCE must match Removed/<id>/<file> AND equal the recorded
// archive.archived_path; restore TARGET must equal archive.original_path and
// match Music/Artists/<folder>/<file>.
export function assertRestore(root: string, source: string, target: string, recorded: { archivedPath: string; originalPath: string }) {
  assertSafePath(source)
  assertSafePath(target)
  if (!patterns(root).restoreSource.test(source)) throw new PathError('restore_source_pattern')
  if (source !== recorded.archivedPath) throw new PathError('restore_source_mismatch')
  if (target !== recorded.originalPath) throw new PathError('restore_target_mismatch')
  if (!patterns(root).artistFile.test(target)) throw new PathError('restore_target_pattern')
  return { source, target }
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  if (i <= 0) throw new PathError('no_dirname')
  return path.slice(0, i)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function isLibrarySurface(root: string, path: string): boolean {
  try {
    assertSafePath(path)
  } catch {
    return false
  }
  return patterns(root).librarySurface.test(path)
}

// Collision-free ingest path: tries `<name>.mp3`, then ` (2)` … ` (9)`,
// re-checking `files/list?flushCache=true` for each candidate. ANY entry at the
// exact path — media, directory, or an unscanned 'File Processing' other —
// counts as taken (P0d-B (c)). All nine taken → throws (caller alerts).
export async function resolveIngestPath(
  root: string,
  folder: string,
  artist: string,
  title: string,
  pathTaken: (dir: string, path: string) => Promise<boolean>,
): Promise<string> {
  for (let n = 1; n <= 9; n++) {
    const p = buildIngestPath(root, folder, ingestFileName(artist, title, n))
    if (!(await pathTaken(dirname(p), p))) return p
  }
  throw new PathError('collision_exhausted')
}
