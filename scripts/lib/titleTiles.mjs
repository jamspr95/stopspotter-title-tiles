// StopSpotter — shared grid math for the on-demand title boundary lookup.
//
// Both build-title-tiles-{ew,scotland}.mjs (Node, this file) and
// supabase/functions/lookup-title-boundary (Deno, can't import a local
// Node file across that runtime boundary) need to compute the exact same
// ids for the exact same point, or a nomination's lookup would miss the
// tile its own title was written into. Every exported function below is
// intentionally tiny and dependency-free so it can be copied verbatim
// into the edge function rather than drifting out of sync — see that
// file's own top-of-file comment for why that's a deliberate tradeoff,
// not an oversight.
//
// Grid choice: a plain WGS84 lat/lng degree grid, not the Ordnance Survey
// National Grid — the parsed parcel data is already WGS84 by the time it
// reaches this module (scripts/lib/bngToWgs84.mjs did that conversion
// upstream), so a second coordinate system here would be pure overhead.
//
// Two grid sizes, for two different jobs — see docs/TITLE_BOUNDARY_API_PLAN.md
// "Phase 0" for the full reasoning:
//   - CELL_SIZE_DEG (0.1°): the fine lookup grid. A shard's CONTENTS stay
//     tagged by this, so the point-in-polygon test at query time only
//     ever scans one small fine cell's worth of parcels.
//   - SHARD_SIZE_DEG (0.5°, FINE_CELLS_PER_SHARD=5 fine cells per side):
//     the file/release-asset boundary, keeping a full-GB build's file
//     count (~128) comfortably under GitHub Releases' 1,000-asset cap.

export const CELL_SIZE_DEG = 0.1
export const FINE_CELLS_PER_SHARD = 5
export const SHARD_SIZE_DEG = CELL_SIZE_DEG * FINE_CELLS_PER_SHARD

/** Must stay identical to the copy in supabase/functions/lookup-title-boundary/index.ts. */
export function cellIdForPoint(lat, lng) {
  const latBucket = Math.floor(lat / CELL_SIZE_DEG)
  const lngBucket = Math.floor(lng / CELL_SIZE_DEG)
  return `${latBucket}_${lngBucket}`
}

/**
 * Which shard file a fine cell id's tile data lives in — many fine cell
 * ids map to the same shard id. Must stay identical to the copy in
 * supabase/functions/lookup-title-boundary/index.ts.
 */
export function shardIdForCellId(cellId) {
  const [latBucket, lngBucket] = cellId.split('_').map(Number)
  const shardLatBucket = Math.floor(latBucket / FINE_CELLS_PER_SHARD)
  const shardLngBucket = Math.floor(lngBucket / FINE_CELLS_PER_SHARD)
  return `${shardLatBucket}_${shardLngBucket}`
}

/**
 * rings: array of rings, each ring an array of [lng, lat] pairs (the same
 * shape scripts/lib/titleBoundariesDb.mjs's ringToWkt already expects).
 * Returns every FINE cell id the rings' combined bounding box overlaps —
 * a parcel near a cell boundary is written into every cell it could
 * plausibly be queried from, not just the one its first point happens to
 * fall in.
 */
export function cellIdsForRings(rings) {
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
  }
  if (!Number.isFinite(minLat)) return []

  const minLatBucket = Math.floor(minLat / CELL_SIZE_DEG)
  const maxLatBucket = Math.floor(maxLat / CELL_SIZE_DEG)
  const minLngBucket = Math.floor(minLng / CELL_SIZE_DEG)
  const maxLngBucket = Math.floor(maxLng / CELL_SIZE_DEG)

  const ids = []
  for (let latBucket = minLatBucket; latBucket <= maxLatBucket; latBucket++) {
    for (let lngBucket = minLngBucket; lngBucket <= maxLngBucket; lngBucket++) {
      ids.push(`${latBucket}_${lngBucket}`)
    }
  }
  return ids
}

import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

// ============================================================================
// Real incident (Oct 2026): the first version of this module merged a new
// council's parcels into a shard by reading the shard's existing gzipped
// file back, decompressing it, and JSON.parsing the whole thing into one
// string/object, merging in memory, then re-serialising and rewriting —
// every time any council touched that shard. In a dense area (several
// large councils sharing one 0.5° shard), that file kept growing and got
// FULLY re-read-and-re-parsed on every touch. A real --all run against
// live HMLR data crashed Node with "JavaScript heap out of memory" after
// a `JSON.parse` call, having already hit "Invalid string length" on
// several earlier councils whose shard had grown past V8's ~1GB string
// limit — confirmed from the real job log, not a guess.
//
// Fix: never read a shard back during the run. Each council's own call
// only ever APPENDS small newline-delimited JSON lines to a plain-text
// "parts" file per shard (cheap, bounded by that one council's own
// feature count, which is what the main loop was already safe for).
// Once every area for a nation has been processed, finalizeShards()
// gzips each shard's accumulated parts file in a single streamed pass —
// data flows through node:zlib's gzip transform in chunks, so even a
// shard whose final content is many gigabytes never needs to exist as
// one in-memory string or object. No dedup-by-title-number pass runs
// any more either (the old version's read-back was also how it deduped
// a title re-sent for the same fine cell) — safe to drop because each
// title number comes from exactly one council's source file in HMLR/RoS
// data, so the only within-run repetition is deliberate (the same
// parcel listed under several neighbouring fine cells it overlaps, each
// a different cache key, never the same one twice).
// ============================================================================

function partsFilePath(outDir, nation, shardId) {
  return join(outDir, nation, '_parts', `${shardId}.ndjson`)
}

/**
 * Appends parcels into per-shard NDJSON "parts" files under
 * outDir/<nation>/_parts/<shardId>.ndjson — one line per feature per fine
 * cell it belongs to, each line carrying its own fine cell id ("c") so
 * finalizeShards (and the edge function reading the finished file) can
 * filter to one fine cell without needing a top-level index structure.
 * Call this once per council/county (same per-area iteration the
 * existing sync-title-boundaries-*.mjs scripts already use); call
 * finalizeShards() once, after every area for this nation has been
 * processed, to produce the actual gzipped shard files.
 *
 * parcels: [{ titleNumber, tenure, polygons }] — polygons as
 * cellIdsForRings() above (array of rings, each [lng, lat] pairs).
 * Returns the number of distinct shards this call touched, for logging.
 */
export async function writeParcelsToShardParts(outDir, nation, parcels) {
  // Grouped by shard first so each shard's parts file gets one append
  // call (one line per feature-per-fine-cell within it) rather than many
  // tiny separate writes.
  const linesByShard = new Map()
  for (const p of parcels) {
    const geometry = { type: 'MultiPolygon', coordinates: p.polygons.map((ring) => [ring]) }
    for (const cellId of cellIdsForRings(p.polygons)) {
      const shardId = shardIdForCellId(cellId)
      const line = JSON.stringify({
        c: cellId,
        type: 'Feature',
        properties: { title_number: p.titleNumber, tenure: p.tenure ?? null },
        geometry,
      })
      if (!linesByShard.has(shardId)) linesByShard.set(shardId, [])
      linesByShard.get(shardId).push(line)
    }
  }

  const dir = join(outDir, nation, '_parts')
  await mkdir(dir, { recursive: true })

  for (const [shardId, lines] of linesByShard) {
    await appendFile(partsFilePath(outDir, nation, shardId), lines.join('\n') + '\n')
  }

  return linesByShard.size
}

/**
 * Streams every shard's accumulated parts file through gzip into the
 * final outDir/<nation>/<shardId>.json.gz, then removes the parts file.
 * Call once, after the last writeParcelsToShardParts() call for a
 * nation. Streamed end to end (createReadStream -> gzip -> createWriteStream),
 * so this is safe even for a shard whose parts file is many gigabytes —
 * nothing here holds more than one stream chunk in memory at a time.
 */
export async function finalizeShards(outDir, nation) {
  const dir = join(outDir, nation, '_parts')
  let partFiles
  try {
    partFiles = await readdir(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return 0 // nothing was ever written for this nation
    throw err
  }

  for (const file of partFiles) {
    if (!file.endsWith('.ndjson')) continue
    const shardId = file.slice(0, -'.ndjson'.length)
    const srcPath = join(dir, file)
    const destPath = join(outDir, nation, `${shardId}.json.gz`)
    await pipeline(createReadStream(srcPath), createGzip(), createWriteStream(destPath))
  }

  await rm(dir, { recursive: true, force: true })
  return partFiles.filter((f) => f.endsWith('.ndjson')).length
}
