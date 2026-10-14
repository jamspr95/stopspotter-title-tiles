// Parses an ESRI Shapefile (.shp geometry + .dbf attributes) into the same
// [{ titleNumber, polygons }] shape scripts/lib/inspireGml.mjs's
// extractParcels() produces from GML — confirmed necessary for real
// Registers of Scotland county downloads: each zip holds a Shapefile, not
// GML as originally assumed (see scripts/sync-title-boundaries-scotland.mjs's
// header comment and git history).
//
// Each county zip has two coordinate-system variants of the same shapefile
// (a "_bng" and an "_etrs89" set) — this always reads the "_bng" one, to
// reuse the same BNG->WGS84 conversion already built and verified for
// HMLR's GML. The field holding the title/INSPIRE reference is unverified
// against a real .dbf (dBASE field names are frequently truncated to 10
// characters, and real field names haven't been confirmed yet) — this
// tries several plausible candidates and fails loudly with the first
// feature's actual property names/values if none of them hit, rather than
// silently loading untitled parcels.

import { open } from 'shapefile'
import { bngToWgs84 } from './bngToWgs84.mjs'

const TITLE_FIELD_CANDIDATES = [
  'NATIONAL_C',
  'NATIONALCADASTRALREFERENCE',
  'INSPIRE_ID',
  'INSPIREID',
  'LABEL',
  'TITLE_NO',
  'TITLENO',
  'TITLE_NUM',
]

function extractTitleNumber(properties) {
  if (!properties) return null
  for (const candidate of TITLE_FIELD_CANDIDATES) {
    for (const [key, value] of Object.entries(properties)) {
      // dBASE field names are commonly truncated to 10 characters, so
      // match on a shared prefix rather than requiring an exact name.
      if (key.toUpperCase().startsWith(candidate.slice(0, 10).toUpperCase())) {
        if (value != null && String(value).trim()) return String(value).trim()
      }
    }
  }
  return null
}

/** A GeoJSON ring (closed [x, y] loop, BNG eastings/northings) -> [lng, lat] pairs. */
function ringFromBngCoordinates(coords) {
  return coords.map(([easting, northing]) => {
    const { lat, lng } = bngToWgs84(easting, northing)
    return [lng, lat]
  })
}

/** Every ring in a GeoJSON Polygon or MultiPolygon geometry, flattened — exterior and any interior/hole rings alike (same disclosed simplification as extractParcels, see inspireGml.mjs). */
function ringsFromGeometry(geometry) {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return geometry.coordinates.map(ringFromBngCoordinates)
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flatMap((rings) => rings.map(ringFromBngCoordinates))
  return []
}

export async function extractParcelsFromShapefile(shpBuffer, dbfBuffer) {
  const source = await open(shpBuffer, dbfBuffer)
  const parcels = []
  let sampleProperties = null
  let result
  while (!(result = await source.read()).done) {
    const feature = result.value
    if (sampleProperties === null) sampleProperties = feature.properties
    const titleNumber = extractTitleNumber(feature.properties)
    const rings = ringsFromGeometry(feature.geometry).filter((r) => r.length >= 4)
    if (titleNumber && rings.length > 0) {
      parcels.push({ titleNumber, polygons: rings })
    }
  }

  if (parcels.length === 0) {
    throw new Error(
      `Parsed zero parcels from the shapefile — the title field guess is likely wrong for this file. Sample feature properties: ${JSON.stringify(sampleProperties)}`,
    )
  }
  return parcels
}
