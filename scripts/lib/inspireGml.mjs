// Shared INSPIRE Cadastral Parcels GML parsing, used by both the
// England/Wales (HMLR) and Scotland (Registers of Scotland) sync scripts.
// Both datasets are published under the same EU INSPIRE Cadastral Parcels
// schema, so the extraction logic is identical — only how each script
// discovers its list of per-area GML downloads differs.

import { gunzipSync } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'
import { unzipSync } from 'fflate'
import { bngToWgs84 } from './bngToWgs84.mjs'

/**
 * True for the specific V8 "string too long" failure a whole-document
 * `.toString('utf8')` call hits on an outlier-sized GML file — see
 * extractParcelsFromLargeBuffer's header comment below for the real
 * incident and the fix. Shared by both build-title-tiles-{ew,scotland}.mjs
 * so each can fall back to the streaming parser on exactly this failure
 * and no other.
 *
 * Real incident (Oct 2026): this originally checked `err instanceof
 * RangeError`, which missed the real failure live. `Buffer.prototype
 * .toString('utf8')` on an oversized buffer throws Node's own
 * `ERR_STRING_TOO_LONG` — a plain `Error` (name "Error", NOT instanceof
 * RangeError) with `.code === 'ERR_STRING_TOO_LONG'` and this same
 * message text. Only the older, string-concatenation-style V8 overflow
 * (`RangeError: Invalid string length`, e.g. from `.repeat()` or `+`)
 * is a true RangeError. Confirmed both shapes directly: Cornwall and
 * The North Yorkshire Council hit the first (so the streaming fallback
 * below never actually ran for them despite looking like it should —
 * the condition silently rethrew instead), Dumfries's parse hit the
 * second. Checking `.code` first catches both regardless of prototype.
 */
export function isStringTooLongError(err) {
  if (err?.code === 'ERR_STRING_TOO_LONG') return true
  return err instanceof RangeError && /string length|longer than/i.test(err.message)
}

/** A manually-downloaded file might be gzipped (common for INSPIRE Atom links) or plain — detect by magic bytes, not the file extension, and decompress either way. */
export function decompressIfGzip(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer).toString('utf8')
  }
  return buffer.toString('utf8')
}

function isZip(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
}

const GML_ENTRY_EXTENSIONS = ['.gml', '.xml']

/**
 * A downloaded file's bytes might be a .zip (confirmed: HMLR's England/
 * Wales download links are .zip archives containing one .gml each, not
 * raw .gml as originally assumed — see this repo's git history), gzip, or
 * plain GML text. Detects by magic bytes, not the file extension or
 * Content-Type, and returns every GML-ish text found inside — more than
 * one for a zip with multiple entries, exactly one otherwise.
 */
export function extractGmlTexts(buffer) {
  if (isZip(buffer)) {
    const entries = unzipSync(buffer)
    const gmlEntries = Object.entries(entries).filter(([name]) =>
      GML_ENTRY_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)),
    )
    if (gmlEntries.length === 0) {
      throw new Error(
        `Zip archive had no .gml/.xml entry — found: ${Object.keys(entries).join(', ') || '(empty archive)'}.`,
      )
    }
    return gmlEntries.map(([, data]) => Buffer.from(data).toString('utf8'))
  }
  return [decompressIfGzip(buffer)]
}

/**
 * Byte-level twin of extractGmlTexts/decompressIfGzip: returns each GML
 * entry as a Buffer, WITHOUT ever calling .toString('utf8') on it. Exists
 * only for extractParcelsFromLargeBuffer below — a Buffer's length limit
 * (~2GB on 64-bit Node) is far past a JS string's (~536M UTF-16 code
 * units), so this is the only way to hold an oversized GML file's bytes
 * at all before streaming-parsing it in bounded windows.
 */
export function extractGmlBuffers(buffer) {
  if (isZip(buffer)) {
    const entries = unzipSync(buffer)
    const gmlEntries = Object.entries(entries).filter(([name]) =>
      GML_ENTRY_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)),
    )
    if (gmlEntries.length === 0) {
      throw new Error(
        `Zip archive had no .gml/.xml entry — found: ${Object.keys(entries).join(', ') || '(empty archive)'}.`,
      )
    }
    return gmlEntries.map(([, data]) => Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return [gunzipSync(buffer)]
  }
  return [buffer]
}

/**
 * Diagnostic for "parsed zero parcels from a non-empty file" — a raw text
 * slice mostly wastes its budget on posList's long digit strings (as the
 * first real HMLR file confirmed: the schema turned out to use its own
 * LR:PREDEFINED feature type, not the standard INSPIRE cp:CadastralParcel
 * this was built against, and that showed up a thousand digits deep into
 * one coordinate list). This instead lists every unique element name found
 * (the fastest way to see what the real feature/geometry tags are called)
 * plus a preview with posList content collapsed, so the rest of a
 * feature's structure — title/reference fields included — actually fits.
 */
export function describeGmlStructure(gmlText) {
  const tagNames = [...new Set([...gmlText.matchAll(/<([A-Za-z_][\w:.-]*)/g)].map((m) => m[1]))].sort()
  // (?!\/) excludes the closing </...posList> tag itself — without it, that
  // tag also matches this pattern (any "<...posList...>" span) and gets a
  // second, spurious placeholder appended right after it.
  const redacted = gmlText.replace(/(<(?!\/)[^>]*posList[^>]*>)[^<]*/gi, '$1[coordinates omitted]')
  return [
    `Unique element names (${tagNames.length}): ${tagNames.join(', ')}`,
    '',
    'Preview with posList coordinates omitted:',
    redacted.slice(0, 4000),
  ].join('\n')
}

/**
 * Recursively finds every object in a parsed-XML tree whose tag name
 * (ignoring a namespace prefix) matches `localName`, case-insensitively.
 * Confirmed necessary against a real HMLR download: it uses its own
 * LR-namespaced, ALL-CAPS element names (LR:PREDEFINED, LR:INSPIREID,
 * LR:NATIONALCADASTRALREFERENCE, ...) rather than the lower/camelCase
 * standard INSPIRE Cadastral Parcels names this was built against — a
 * case-sensitive match found almost none of them.
 */
export function findByLocalName(node, localName, results = []) {
  if (node == null || typeof node !== 'object') return results
  const target = localName.toLowerCase()
  for (const [key, value] of Object.entries(node)) {
    const bareName = key.includes(':') ? key.split(':').pop() : key
    if (bareName.toLowerCase() === target) {
      for (const v of Array.isArray(value) ? value : [value]) results.push(v)
    }
    for (const v of Array.isArray(value) ? value : [value]) findByLocalName(v, localName, results)
  }
  return results
}

// Confirmed against a real HMLR download: the feature type is its own
// LR:PREDEFINED, not the standard INSPIRE cp:CadastralParcel this was
// originally built against — kept both since Scotland's real shape is
// still unverified and might use either.
const PARCEL_FEATURE_NAMES = ['CadastralParcel', 'PREDEFINED']

const TITLE_NUMBER_KEYS = ['nationalCadastralReference', 'label', 'INSPIREID', 'inspireId', 'title_number', 'TITLE_NO']

// Confirmed against a real HMLR download: LR:INSPIREID's text is a bare
// number like 63934897, not a string — fast-xml-parser auto-converts
// purely-numeric element text to a JS number, so a string-only check here
// silently found nothing for every real title reference.
function textValue(v) {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  const inner = v?.['#text'] ?? v?.localId
  if (typeof inner === 'string') return inner.trim() || null
  if (typeof inner === 'number') return String(inner)
  return null
}

function extractTitleNumber(parcelNode) {
  for (const key of TITLE_NUMBER_KEYS) {
    const found = findByLocalName(parcelNode, key)
    for (const v of found) {
      const text = textValue(v)
      if (text) return text
    }
  }
  return null
}

/** One posList's text ("E1 N1 E2 N2 ...") -> one ring of [lng, lat] pairs. */
function posListToRing(posListText) {
  const nums = posListText.trim().split(/\s+/).map(Number)
  const ring = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const { lat, lng } = bngToWgs84(nums[i], nums[i + 1])
    ring.push([lng, lat])
  }
  return ring
}

/**
 * Parses one GML document's text into [{ titleNumber, polygons }], polygons
 * each a ring of [lng, lat] pairs.
 *
 * Known, disclosed gap: every posList found under a parcel (exterior AND
 * any interior/hole ring alike — confirmed real HMLR files do have
 * `gml:interior` rings) is treated as its own independent filled ring, not
 * a polygon-with-a-hole. A parcel with a hole therefore loads as the outer
 * shape plus an extra filled blob where the hole is, instead of a single
 * shape with that area cut out — a real but minor fidelity gap against
 * data that's only ever "indicative extent" to begin with. Fixing it
 * properly means distinguishing exterior/interior per gml:Polygon and
 * writing proper polygon-with-holes WKT, which wasn't done here.
 */
export function extractParcels(gmlText) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' })
  const doc = parser.parse(gmlText)
  const parcelNodes = PARCEL_FEATURE_NAMES.flatMap((n) => findByLocalName(doc, n))
  const parcels = []
  for (const node of parcelNodes) {
    const titleNumber = extractTitleNumber(node)
    const posLists = findByLocalName(node, 'posList')
    const rings = posLists
      .map((p) => (typeof p === 'string' ? p : p?.['#text']))
      .filter((t) => typeof t === 'string')
      .map(posListToRing)
      .filter((ring) => ring.length >= 4) // a closed ring needs at least 4 points (3 distinct + closing)
    if (titleNumber && rings.length > 0) {
      parcels.push({ titleNumber, polygons: rings })
    }
  }
  return parcels
}

// Matches one parcel feature's OPENING tag (any namespace prefix, either
// known local name), capturing the exact tag text written (e.g.
// "LR:PREDEFINED") so the matching closing tag can be searched for by the
// same literal string — real files use one prefix consistently, but this
// doesn't assume which one.
const FEATURE_OPEN_TAG_RE = new RegExp(`<((?:[\\w.-]+:)?(?:${PARCEL_FEATURE_NAMES.join('|')}))\\b[^>]*>`, 'gi')

const DEFAULT_WINDOW_BYTES = 32 * 1024 * 1024 // 32MB — arbitrary but small enough that a single window's .toString('utf8') is nowhere near V8's ~536M-character string limit, large enough that most real feature elements fit inside one window untouched by a chunk boundary
const MAX_CARRY_CHARS = 64 * 1024 * 1024 // safety valve — see below

/**
 * Real incident (Oct 2026): decoding a handful of outlier-sized councils'
 * GML (The North Yorkshire Council, Cornwall) and counties' GML (Dumfries)
 * as one JS string — what extractGmlTexts/decompressIfGzip's
 * `.toString('utf8')` does — hit V8's hard per-string length ceiling
 * ("Cannot create a string longer than 0x1fffffe8 characters" /
 * "Invalid string length"), confirmed from real job logs. These files are
 * large enough that even the UTF-16 string representation of their raw
 * UTF-8 bytes exceeds that ceiling.
 *
 * Fix: never hold the whole document as one string. This reads the raw
 * bytes (a Buffer, not stringified — extractGmlBuffers above) in fixed-
 * size windows, stringifying only one bounded window at a time (always
 * far under the limit), and extracts each complete parcel-feature element
 * as soon as both its opening and closing tag have appeared across the
 * accumulated (but bounded) text — at which point that one small feature
 * string is handed to extractParcels() UNCHANGED, reusing the exact same
 * proven parsing logic (title-number extraction, posList→ring conversion,
 * the LR:PREDEFINED-vs-cp:CadastralParcel tolerance) already verified
 * against 315+ real councils/counties. Only how the raw bytes get split
 * into feature-sized pieces is new here — not how a feature gets parsed.
 *
 * A feature split across a window boundary is handled naturally: if a
 * window ends mid-feature (opening tag seen, closing tag not yet), that
 * partial text is carried forward and prepended to the next window rather
 * than discarded.
 */
export function extractParcelsFromLargeBuffer(gmlBuffer, { windowBytes = DEFAULT_WINDOW_BYTES } = {}) {
  const parcels = []
  let carry = ''
  let offset = 0

  while (offset < gmlBuffer.length) {
    let end = Math.min(offset + windowBytes, gmlBuffer.length)
    // Never split a multi-byte UTF-8 character across the window boundary:
    // back off while the next byte is a UTF-8 continuation byte (10xxxxxx),
    // unless this window already reaches the buffer's real end.
    if (end < gmlBuffer.length) {
      while (end > offset && (gmlBuffer[end] & 0xc0) === 0x80) end--
    }
    carry += gmlBuffer.toString('utf8', offset, end)
    offset = end

    let consumedThrough = 0
    FEATURE_OPEN_TAG_RE.lastIndex = 0
    let openMatch
    while ((openMatch = FEATURE_OPEN_TAG_RE.exec(carry))) {
      const tagName = openMatch[1]
      const closeTag = `</${tagName}>`
      const closeIdx = carry.indexOf(closeTag, FEATURE_OPEN_TAG_RE.lastIndex)
      if (closeIdx === -1) break // closing tag not in the buffer yet — stop, carry the rest forward

      const featureXml = carry.slice(openMatch.index, closeIdx + closeTag.length)
      parcels.push(...extractParcels(featureXml))
      consumedThrough = closeIdx + closeTag.length
      FEATURE_OPEN_TAG_RE.lastIndex = consumedThrough
    }
    carry = carry.slice(consumedThrough)

    // Safety valve: a feature's open tag found but no close tag across an
    // ever-growing carry means something doesn't match expectations (a
    // genuinely malformed file, or these features really do nest/span
    // more than 64MB of markup, which real cadastral data never does) —
    // fail loudly rather than silently re-accumulating toward the same
    // string-length ceiling this function exists to avoid.
    if (carry.length > MAX_CARRY_CHARS) {
      throw new Error(
        `extractParcelsFromLargeBuffer: no complete parcel feature closed within a ${MAX_CARRY_CHARS / (1024 * 1024)}MB window — the file's structure doesn't match what this streaming parser expects (a flat, non-nested list of ${PARCEL_FEATURE_NAMES.join('/')} elements).`,
      )
    }
  }

  // Reaching end-of-input with an unclosed feature tag still in `carry`
  // means the file was truncated or malformed (the 64MB valve above only
  // catches an unclosed tag that grew large before input ran out, not one
  // that simply ran out of bytes) — fail loudly here too, rather than
  // silently returning whatever parcels happened to close before the cut.
  FEATURE_OPEN_TAG_RE.lastIndex = 0
  if (FEATURE_OPEN_TAG_RE.test(carry)) {
    throw new Error(
      `extractParcelsFromLargeBuffer: input ended with an unclosed parcel feature tag still open — the file is likely truncated or malformed.`,
    )
  }

  return parcels
}
