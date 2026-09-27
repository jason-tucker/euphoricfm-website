// Song metadata characters (v0.2.1, review SEC-3). One rule for every place
// a title / artist / album / genre enters the portal:
//   * member and reviewer edits (requests/common.ts metaText) REJECT it;
//   * the probe's music-metadata child (mm-child.ts) CLEANS pre-filled ID3
//     tags with clipTag(), so an untouched pre-fill always passes the edit
//     rule and the finalize tag rule (spool/protocol.ts tagString).
// Disallowed: control characters (\p{Cc}, including \n and \t), format
// characters (\p{Cf}: bidi overrides such as U+202E, zero-width U+200B/200D,
// U+FEFF, soft hyphen) and the line / paragraph separators U+2028 / U+2029.
// A format character would make what reviewers see differ from what goes on
// air; a control character fails finalize after approval.
//
// Kept free of imports: it is bundled into the heap-capped mm-child.

export const META_DISALLOWED_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u
export const MAX_TAG_CHARS = 200

// Breaks (controls, U+2028/9) become one space so "Foo\r\nBar" stays two
// words; invisible format characters are dropped. Then NFC (after the
// removal: dropping a ZWJ can leave a decomposed sequence), trim, and clip to
// MAX_TAG_CHARS UTF-16 units without leaving half of a surrogate pair.
export function clipTag(s: unknown): string | null {
  if (typeof s !== 'string') return null
  let out = s
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .normalize('NFC')
    .trim()
    .slice(0, MAX_TAG_CHARS)
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1)
  return out.trim() || null
}
