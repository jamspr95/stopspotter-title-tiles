// Unified "raw downloaded bytes -> parcels" entry point for a source that
// might hand back GML (gzipped, plain, or zipped) or an ESRI Shapefile set
// zipped together — confirmed real for Registers of Scotland's county
// downloads: each zip holds a Shapefile, not GML (see
// scripts/sync-title-boundaries-scotland.mjs's header comment and git
// history for how that was found). Each Scotland zip has two coordinate-
// system variants of the same shapefile (a "_bng" and an "_etrs89" set) —
// this always reads the "_bng" one, reusing the same BNG->WGS84 pipeline
// already built and verified for HMLR's GML.
//
// Throws with the zip's actual contents listed if it recognises neither
// shape, rather than guessing at a third format.

import { unzipSync } from 'fflate'
import {
  describeGmlStructure,
  extractGmlBuffers,
  extractParcels,
  extractParcelsFromLargeBuffer,
  isStringTooLongError,
} from './inspireGml.mjs'
import { extractParcelsFromShapefile } from './shapefileParcels.mjs'

function isZip(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
}

/**
 * Real incident (Oct 2026): Dumfries failed with "Invalid string length" —
 * the same V8 string-length ceiling as England & Wales's outlier-sized
 * councils (see inspireGml.mjs's extractParcelsFromLargeBuffer), hit
 * somewhere in this GML branch's whole-document stringification. Tries
 * the normal path first, falls back to the streaming parser ONLY on that
 * specific failure — everything else (a real schema mismatch, a corrupt
 * download) still surfaces unchanged.
 */
function parseGmlBuffer(gmlBuffer) {
  try {
    return { parcels: extractParcels(gmlBuffer.toString('utf8')), streamed: false, sampleText: () => gmlBuffer.toString('utf8') }
  } catch (err) {
    if (!isStringTooLongError(err)) throw err
    return { parcels: extractParcelsFromLargeBuffer(gmlBuffer), streamed: true, sampleText: null }
  }
}

export async function extractParcelsFromBytes(buffer) {
  if (!isZip(buffer)) {
    // Not a zip, so this is the plain-or-gzip case — extractGmlBuffers'
    // non-zip branch is exactly gzip-detect-and-decompress-to-Buffer-or-
    // passthrough, with no .gml/.xml entry filtering to worry about
    // (that only applies to its zip branch, which we already know this
    // isn't).
    const [gmlBuffer] = extractGmlBuffers(buffer)
    return parseGmlBuffer(gmlBuffer).parcels
  }

  const entries = unzipSync(buffer)
  const names = Object.keys(entries)

  const gmlNames = names.filter((n) => /\.(gml|xml)$/i.test(n))
  if (gmlNames.length > 0) {
    let parcels = []
    let streamedAny = false
    let firstSampleText = null
    for (const n of gmlNames) {
      const entryBuffer = Buffer.from(entries[n].buffer, entries[n].byteOffset, entries[n].byteLength)
      const result = parseGmlBuffer(entryBuffer)
      if (result.streamed) streamedAny = true
      else if (firstSampleText === null) firstSampleText = result.sampleText()
      parcels = parcels.concat(result.parcels)
    }
    if (parcels.length === 0) {
      throw new Error(
        `Parsed zero parcels from a non-empty GML download — the parser's assumptions about this file's schema are likely wrong. ${
          firstSampleText ? describeGmlStructure(firstSampleText) : '(streamed parse — no single sample text available)'
        }`,
      )
    }
    if (streamedAny) console.log('    (used the streaming parser for at least one oversized GML entry)')
    return parcels
  }

  const bngShpName = names.find((n) => /_bng\.shp$/i.test(n))
  if (bngShpName) {
    const base = bngShpName.slice(0, -'.shp'.length)
    const dbfName = names.find((n) => n.toLowerCase() === `${base.toLowerCase()}.dbf`)
    if (!dbfName) {
      throw new Error(`Found ${bngShpName} but no matching .dbf in the same zip — contents: ${names.join(', ')}`)
    }
    return extractParcelsFromShapefile(Buffer.from(entries[bngShpName]), Buffer.from(entries[dbfName]))
  }

  throw new Error(
    `Zip archive had no .gml/.xml and no _bng.shp entry — the parser's assumptions about this source's packaging are wrong. Contents: ${names.join(', ')}`,
  )
}
