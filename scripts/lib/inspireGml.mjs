// Shared INSPIRE Cadastral Parcels GML parsing, used by both the
// England/Wales (HMLR) and Scotland (Registers of Scotland) sync scripts.
// Both datasets are published under the same EU INSPIRE Cadastral Parcels
// schema, so the extraction logic is identical — only how each script
// discovers its list of per-area GML downloads differs.

import { gunzipSync } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'
import { unzipSync } from 'fflate'
import { bngToWgs84 } from './bngToWgs84.mjs'

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
