// A faithful TS port of how AzuraCast turns a playlist NAME into the
// Liquidsoap variable it writes into the station's .liq (2026-09-29 incident:
// "~EVT1 s1" became `playlist_~evt1_s1`, Liquidsoap refused the config with
// "Error 2: Parse error" and station 14 went FATAL).
//
//   ConfigWriter::getPlaylistVariableName($playlist)
//     = cleanUpVarName('playlist_' . $playlist->getShortName())
//   StationPlaylist::getShortName()
//     = Station::generateShortName($name)
//     = is_numeric(s = File::sanitizeFileName($name)) ? 'station_' . s : s
//   File::sanitizeFileName = Strings::getProgrammaticString
//
// Used by the unit tests (test/events-liq-names.test.ts), the unit fake
// (test/events-fakes.ts) and the harness mock (test/mocks/server.mjs, which
// imports this file through Node's type stripping — so ERASABLE TypeScript
// only: no enums, no namespaces, no parameter properties, no path aliases).

export type LiqPortOptions = {
  // mb_ereg's \w under PHP's default UTF-8 regex encoding is Unicode-aware
  // (Oniguruma "Word": Alphabetic, marks, decimal digits, connector
  // punctuation, join controls). `asciiWord` runs the same pipeline with an
  // ASCII-only \w, so the tests hold for either Oniguruma build.
  asciiWord?: boolean
}

/** A token Liquidsoap parses as a plain variable name. */
export const LIQUIDSOAP_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Strings::getProgrammaticString:
//   mb_ereg_replace("([^\w\s\d\-_~,;\[\]\(\).])", '', $str)
//   mb_ereg_replace("([\.]{2,})", '.', $result)
//   str_replace(' ', '_', $result)
//   mb_strtolower($result)
// Oniguruma (UTF-8): \s = White_Space, \d = Nd (a subset of Word).
const PROGRAMMATIC_STRIP_UNICODE = /[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}\p{White_Space}\-_~,;[\]().]/gu
const PROGRAMMATIC_STRIP_ASCII = /[^A-Za-z0-9_\p{White_Space}\-~,;[\]().]/gu

export function getProgrammaticString(str: string, opts: LiqPortOptions = {}): string {
  let s = str.replace(opts.asciiWord ? PROGRAMMATIC_STRIP_ASCII : PROGRAMMATIC_STRIP_UNICODE, '')
  s = s.replace(/\.{2,}/g, '.')
  s = s.split(' ').join('_')
  return s.toLowerCase() // mb_strtolower: full Unicode lower-case mapping
}

// PHP is_numeric (PHP 8: leading and trailing whitespace allowed).
const PHP_NUMERIC_RE = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/

/** Station::generateShortName (what StationPlaylist::getShortName returns). */
export function playlistShortName(name: string, opts: LiqPortOptions = {}): string {
  const s = getProgrammaticString(name, opts)
  return PHP_NUMERIC_RE.test(s) ? `station_${s}` : s
}

// htmlentities($s, ENT_QUOTES, 'utf-8') with PHP's default ENT_HTML401 table:
// every character with a named HTML 4.01 entity, plus ' → &#039;.
const HTML401: Record<number, string> = {
  34: 'quot', 38: 'amp', 60: 'lt', 62: 'gt',
  338: 'OElig', 339: 'oelig', 352: 'Scaron', 353: 'scaron', 376: 'Yuml', 402: 'fnof', 710: 'circ', 732: 'tilde',
  977: 'thetasym', 978: 'upsih', 982: 'piv',
  8194: 'ensp', 8195: 'emsp', 8201: 'thinsp', 8204: 'zwnj', 8205: 'zwj', 8206: 'lrm', 8207: 'rlm', 8211: 'ndash', 8212: 'mdash',
  8216: 'lsquo', 8217: 'rsquo', 8218: 'sbquo', 8220: 'ldquo', 8221: 'rdquo', 8222: 'bdquo', 8224: 'dagger', 8225: 'Dagger',
  8226: 'bull', 8230: 'hellip', 8240: 'permil', 8242: 'prime', 8243: 'Prime', 8249: 'lsaquo', 8250: 'rsaquo', 8254: 'oline',
  8260: 'frasl', 8364: 'euro', 8465: 'image', 8472: 'weierp', 8476: 'real', 8482: 'trade', 8501: 'alefsym',
  8592: 'larr', 8593: 'uarr', 8594: 'rarr', 8595: 'darr', 8596: 'harr', 8629: 'crarr', 8656: 'lArr', 8657: 'uArr', 8658: 'rArr', 8659: 'dArr', 8660: 'hArr',
  8704: 'forall', 8706: 'part', 8707: 'exist', 8709: 'empty', 8711: 'nabla', 8712: 'isin', 8713: 'notin', 8715: 'ni', 8719: 'prod', 8721: 'sum',
  8722: 'minus', 8727: 'lowast', 8730: 'radic', 8733: 'prop', 8734: 'infin', 8736: 'ang', 8743: 'and', 8744: 'or', 8745: 'cap', 8746: 'cup',
  8747: 'int', 8756: 'there4', 8764: 'sim', 8773: 'cong', 8776: 'asymp', 8800: 'ne', 8801: 'equiv', 8804: 'le', 8805: 'ge',
  8834: 'sub', 8835: 'sup', 8836: 'nsub', 8838: 'sube', 8839: 'supe', 8853: 'oplus', 8855: 'otimes', 8869: 'perp', 8901: 'sdot',
  8968: 'lceil', 8969: 'rceil', 8970: 'lfloor', 8971: 'rfloor', 9001: 'lang', 9002: 'rang', 9674: 'loz', 9824: 'spades', 9827: 'clubs', 9829: 'hearts', 9830: 'diams',
}
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
LATIN1.split(' ').forEach((n, i) => {
  HTML401[160 + i] = n
})
const GREEK_UPPER = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho _ Sigma Tau Upsilon Phi Chi Psi Omega'
const GREEK_LOWER = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega'
GREEK_UPPER.split(' ').forEach((n, i) => {
  if (n !== '_') HTML401[913 + i] = n
})
GREEK_LOWER.split(' ').forEach((n, i) => {
  HTML401[945 + i] = n
})
const ENTITY_TO_CP = new Map(Object.entries(HTML401).map(([cp, n]) => [n, Number(cp)]))

const hasLoneSurrogate = (s: string) => /\p{Cs}/u.test(s)

function htmlEntities(s: string): string {
  // Invalid UTF-8 (a lone surrogate here) makes htmlentities return ''.
  if (hasLoneSurrogate(s)) return ''
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp === 39) out += '&#039;'
    else if (HTML401[cp] !== undefined) out += `&${HTML401[cp]};`
    else out += ch
  }
  return out
}

// html_entity_decode(ENT_QUOTES, 'utf-8'): named HTML 4.01 entities plus
// &#039;/&apos; and numeric references. (getProgrammaticString removes '&',
// so on AzuraCast's real path this step never sees an entity.)
function htmlEntityDecode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m
    }
    if (ref === 'apos') return "'"
    const cp = ENTITY_TO_CP.get(ref)
    return cp === undefined ? m : String.fromCodePoint(cp)
  })
}

// PHP rawurlencode (RFC 3986): everything but A-Z a-z 0-9 - _ . ~ becomes
// %XX (upper-case hex) per UTF-8 byte. NOTE: '~' is NOT encoded — that is
// what let "~EVT1 s1" through as `playlist_~evt1_s1`.
function rawUrlEncode(s: string): string {
  let out = ''
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b)
    out += /[A-Za-z0-9\-_.~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

// strip_tags: removes <…> tags and NUL bytes. getProgrammaticString has
// already removed '<' and '>', so on AzuraCast's real path this is a no-op;
// the simplified form below is exact for any input without '<'.
function stripTags(s: string): string {
  return s.replace(/<[^>]*(>|$)/g, '').replace(/\0/g, '')
}

// PHP 8.2+ strtolower: ASCII only, locale-independent.
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** ConfigWriter::cleanUpVarName. */
export function cleanUpVarName(input: string): string {
  let str = stripTags(input)
  str = str.replace(/[\r\n\t ]+/g, ' ').replace(/["*/:<>?'|]+/g, ' ')
  str = asciiLower(str)
  str = htmlEntityDecode(str)
  str = htmlEntities(str)
  str = str.replace(/(&)([a-z])([a-z]+;)/gi, '$2')
  str = rawUrlEncode(str.split(' ').join('_'))
  return str.split('%').join('').split('-').join('_').split('.').join('_')
}

/** The Liquidsoap variable AzuraCast writes for a playlist named `name`. */
export function azuracastLiqVarName(name: string, opts: LiqPortOptions = {}): string {
  return cleanUpVarName(`playlist_${playlistShortName(name, opts)}`)
}

/** Whether AzuraCast would write a playlist of this name as a valid Liquidsoap identifier. */
export function isLiquidsoapSafePlaylistName(name: string, opts: LiqPortOptions = {}): boolean {
  return LIQUIDSOAP_IDENT_RE.test(azuracastLiqVarName(name, opts))
}
