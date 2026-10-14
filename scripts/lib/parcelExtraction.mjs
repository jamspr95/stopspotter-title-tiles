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
import { decompressIfGzip, describeGmlStructure, extractParcels } from './inspireGml.mjs'
import { extractParcelsFromShapefile } from './shapefileParcels.mjs'

function isZip(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
}

export async function extractParcelsFromBytes(buffer) {
  if (!isZip(buffer)) {
    return extractParcels(decompressIfGzip(buffer))
  }

  const entries = unzipSync(buffer)
  const names = Object.keys(entries)

  const gmlNames = names.filter((n) => /\.(gml|xml)$/i.test(n))
  if (gmlNames.length > 0) {
    const gmlTexts = gmlNames.map((n) => Buffer.from(entries[n]).toString('utf8'))
    const parcels = gmlTexts.flatMap(extractParcels)
    if (parcels.length === 0) {
      throw new Error(
        `Parsed zero parcels from a non-empty GML download — the parser's assumptions about this file's schema are likely wrong. ${describeGmlStructure(gmlTexts[0])}`,
      )
    }
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
