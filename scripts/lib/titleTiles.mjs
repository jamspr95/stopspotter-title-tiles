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
//   - SHARD_SIZE_DEG (FINE_CELLS_PER_SHARD fine cells per side): the
//     file/release-asset boundary.
//
// Real incident (20 Oct 2026): FINE_CELLS_PER_SHARD was 5 (0.5° shards)
// until the "Look up title" button started failing with "CPU Time
// exceeded" on every real query. A real shard checked directly was
// 186MB decompressed, 75,349 lines - just gzip-DECOMPRESSING one shard
// already cost ~2.1s of CPU time on Supabase's Edge Functions, which
// hard-caps CPU time at 2s per request and isn't configurable on the
// hosted platform (self-hosting only). First shrunk to 2 (0.2° shards),
// which fixed the typical case but NOT the real worst case: measured
// directly against the real rebuilt data, the densest England & Wales
// shard (central London) still decompressed to 457MB (~5.6s CPU), and
// the worst Scotland shard - only 1,458 lines, but 240MB decompressed
// (~16s CPU) - turned out to have a DIFFERENT root cause entirely (see
// writeParcelsToShardParts' own comment below).
//
// Shrunk again, this time to 1 - i.e. no shard grouping at all, a shard
// IS a fine cell - which quarters a dense area's worst-case file size on
// its own. Combined with writeParcelsToShardParts' per-ring fix below
// (which was the dominant fix for Scotland's specific outliers), this
// brought every real shard safely under budget - see this repo's build
// workflow for the actual post-fix measurements.
//
// Four fine cells per shard (1,000ish EW/Scotland releases combined)
// quadruples again at FINE_CELLS_PER_SHARD=1 - comfortably past GitHub's
// 1,000-asset-per-release cap on its own now, which is why publishing
// also split further, into releasePartitionForShardId's NUM_RELEASE_PARTITIONS
// releases per nation rather than just one - see that function's comment.
export const CELL_SIZE_DEG = 0.1
export const FINE_CELLS_PER_SHARD = 1
export const SHARD_SIZE_DEG = CELL_SIZE_DEG * FINE_CELLS_PER_SHARD

// How many fine-cell-wide bands a nation's shard count enough to still
// exceed GitHub's 1,000-asset-per-release cap. Splitting further than two
// releases is why this isn't simply hardcoded to 2: NUM_RELEASE_PARTITIONS
// needs recomputing whenever the real post-build shard count changes
// enough to threaten the cap again - see build-title-tiles.yml's own
// asset-count check, which is the thing that actually catches that,
// loudly, rather than trusting this comment to stay accurate forever.
export const NUM_RELEASE_PARTITIONS = 3

/**
 * Which of a nation's NUM_RELEASE_PARTITIONS releases a shard's assets
 * get published to / fetched from — split by the shard's latitude band,
 * modulo the partition count, rather than by a fixed real-world latitude
 * threshold. A modulo split needs no assumption about where a nation's
 * real latitude range starts or ends (robust to future data, e.g. a
 * future nation added to this pipeline), and spreads adjacent-latitude
 * shards across *different* partitions — avoiding the lopsided releases
 * a naive "first third of the lat range" split would produce if real
 * parcel density itself varies by latitude band (as the England & Wales
 * data already does - see FINE_CELLS_PER_SHARD's own comment on where
 * the density problem concentrates).
 * Must stay identical to the copy in
 * supabase/functions/lookup-title-boundary/index.ts.
 */
export function releasePartitionForShardId(shardId) {
  const [latBucket] = shardId.split('_').map(Number)
  return ((latBucket % NUM_RELEASE_PARTITIONS) + NUM_RELEASE_PARTITIONS) % NUM_RELEASE_PARTITIONS
}

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
import { simplifyRing } from './simplifyRing.mjs'

// ~3m at the equator (1° latitude ≈ 111,320m) — small relative to a
// parcel boundary survey's own real-world accuracy, and the stored
// geometry is already documented as "an indicative extent, not the legal
// boundary" (0015_title_boundaries.sql), so shaving near-collinear
// vertices off it changes nothing that actually mattered before this
// fix. See simplifyRing.mjs's own header comment for the real incident
// this exists for.
const SIMPLIFY_TOLERANCE_DEG = 0.00003

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
 *
 * Real incident (20 Oct 2026): a real Scottish title (SCT0002609904) is
 * ONE line of NDJSON output but 1.19MB by itself — 232 disjoint polygon
 * members (a title registered as scattered parts, e.g. common grazing
 * rights spread across a whole county), several individual rings 200-340
 * points long. The previous version of this function tagged a parcel's
 * FULL geometry — every one of its members, together — into every fine
 * cell touched by the COMBINED bounding box of all of them, computed in
 * one cellIdsForRings(p.polygons) call. For a compact, single-member
 * parcel (the overwhelming majority) that combined bbox IS the parcel's
 * own real extent, so this was never wrong — but for a scattered title
 * like this one, the combined bbox spans the whole county, so its entire
 * 1.19MB geometry got duplicated into every fine cell across that span,
 * including cells nowhere near any of its actual land. That's what made
 * the shard containing it 240MB decompressed from only 1,458 lines — not
 * shard size, a bounding-box mismatch.
 *
 * Fixed by tagging and writing PER RING instead of per parcel: each
 * ring's own (small, honest) bounding box decides which fine cell(s) it
 * — and only it — gets written into, and each written feature carries
 * just that one ring, not the parcel's other, unrelated members. A
 * genuinely compact single-ring parcel (everything else) is completely
 * unaffected — cellIdsForRings([ring]) for its one ring is identical to
 * the old cellIdsForRings(p.polygons) call. At query time this is
 * transparent: fetchTile already accumulates every matching line for a
 * cell into an array and findMatch already checks each one in turn, so
 * several single-ring features sharing a title_number for the same cell
 * behave exactly like the old multi-member feature did — except a lookup
 * now also only ever returns the ONE member actually near the query
 * point, rather than a scattered title's entire combined outline, which
 * is a more sensible "indicative extent" for the admin map to draw
 * anyway.
 */
export async function writeParcelsToShardParts(outDir, nation, parcels) {
  // Grouped by shard first so each shard's parts file gets one append
  // call (one line per feature-per-fine-cell within it) rather than many
  // tiny separate writes.
  const linesByShard = new Map()
  for (const p of parcels) {
    for (const ring of p.polygons) {
      // cellIdsForRings runs against the ORIGINAL ring — simplification
      // can only drop points under the tolerance, so it can never move a
      // ring's true bounding box, but cell membership is decided first
      // regardless, so that's never something this code has to rely on.
      const cellIds = cellIdsForRings([ring])
      const simplifiedRing = simplifyRing(ring, SIMPLIFY_TOLERANCE_DEG)
      const geometry = { type: 'MultiPolygon', coordinates: [[simplifiedRing]] }
      for (const cellId of cellIds) {
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
  }

  const dir = join(outDir, nation, '_parts')
  await mkdir(dir, { recursive: true })

  // Real incident (Oct 2026): Dumfries's own parse succeeded (30,752
  // parcels, confirmed from the real job log) but the NEXT line —
  // `lines.join('\n')` — hit "Invalid string length". Registration
  // counties don't deduplicate the way England/Wales councils do, so a
  // large county's own single call here can still produce far more
  // lines for one shard than any one council ever did; joining them all
  // into one string hits the exact same V8 ceiling
  // extractParcelsFromLargeBuffer exists to avoid on the parsing side.
  // Fix: append in bounded batches — still far fewer, larger writes than
  // one appendFile() per line, but no single string ever holds more
  // than LINES_PER_APPEND_BATCH lines' worth of JSON.
  const LINES_PER_APPEND_BATCH = 5000
  for (const [shardId, lines] of linesByShard) {
    const path = partsFilePath(outDir, nation, shardId)
    for (let i = 0; i < lines.length; i += LINES_PER_APPEND_BATCH) {
      const batch = lines.slice(i, i + LINES_PER_APPEND_BATCH)
      await appendFile(path, batch.join('\n') + '\n')
    }
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
