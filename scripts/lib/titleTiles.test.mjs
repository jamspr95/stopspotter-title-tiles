import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import {
  cellIdForPoint,
  cellIdsForRings,
  CELL_SIZE_DEG,
  FINE_CELLS_PER_SHARD,
  finalizeShards,
  shardIdForCellId,
  writeParcelsToShardParts,
} from './titleTiles.mjs'

assert.equal(CELL_SIZE_DEG, 0.1)

// A point and its fine cell id must agree with where a ring containing
// that point gets filed — this is the one invariant the whole lookup
// depends on (the build script and the edge function must bucket the
// same point into the same cell id, and then the same shard id).
const exeterPoint = [-3.5339, 50.7184] // [lng, lat]
const exeterCellId = cellIdForPoint(exeterPoint[1], exeterPoint[0])
assert.equal(exeterCellId, `${Math.floor(50.7184 / CELL_SIZE_DEG)}_${Math.floor(-3.5339 / CELL_SIZE_DEG)}`)

// A small square ring entirely inside one fine cell should map to
// exactly that one cell.
const tinyRing = [
  [-3.54, 50.71],
  [-3.53, 50.71],
  [-3.53, 50.72],
  [-3.54, 50.72],
  [-3.54, 50.71],
]
const tinyCells = cellIdsForRings([tinyRing])
assert.deepEqual(tinyCells, [cellIdForPoint(50.715, -3.535)])

// A ring spanning two fine cells' worth of longitude must appear in both.
const wideRing = [
  [-3.65, 50.71],
  [-3.45, 50.71],
  [-3.45, 50.72],
  [-3.65, 50.72],
  [-3.65, 50.71],
]
const wideCells = cellIdsForRings([wideRing])
assert.ok(wideCells.length >= 2, `expected >=2 cells for a wide ring, got ${wideCells.length}`)

// shardIdForCellId: every fine cell within one FINE_CELLS_PER_SHARD x
// FINE_CELLS_PER_SHARD block must resolve to the same shard id, and a
// fine cell just outside that block must resolve to a different one.
// Base is deliberately chosen at a shard-aligned start (both bucket
// values exact multiples of FINE_CELLS_PER_SHARD) — floor() groups
// [n*k, n*k+1, ..., n*k+k-1] into shard n, so only a block starting
// exactly there can safely add up to k-1 and stay inside it; starting
// from an arbitrary (non-aligned) cell id, as an earlier version of this
// test did, can walk into the next shard for negative buckets.
const baseCellId = '500_-40'
const [baseLat, baseLng] = baseCellId.split('_').map(Number)
const sameShardCellId = `${baseLat + FINE_CELLS_PER_SHARD - 1}_${baseLng + FINE_CELLS_PER_SHARD - 1}`
const differentShardCellId = `${baseLat + FINE_CELLS_PER_SHARD}_${baseLng}`
assert.equal(shardIdForCellId(baseCellId), shardIdForCellId(sameShardCellId))
assert.notEqual(shardIdForCellId(baseCellId), shardIdForCellId(differentShardCellId))

// writeParcelsToShardParts + finalizeShards: write once, then append a
// second parcel to a DIFFERENT fine cell that lands in the SAME shard, and
// confirm both survive as separate lines in one finalized gzipped shard
// file (no accidental overwrite across fine cells, and no duplicate shard
// files). Unlike the old read-modify-write design, re-sending the same
// title_number again does NOT replace an earlier line — each call is a
// pure append, so both lines show up; see titleTiles.mjs's header comment
// for why the within-run dedup this used to do was dropped as unnecessary.
const outDir = await mkdtemp(join(tmpdir(), 'title-tiles-test-'))
try {
  const fineCellIdA = cellIdForPoint(50.715, -3.535) // tinyRing's cell
  // Pick whichever neighbour (lng bucket -1 or +1) actually shares A's
  // shard — which direction that is depends on where A happens to sit
  // within its own shard block, not something safe to assume either way.
  const [aLatBucket, aLngBucket] = fineCellIdA.split('_').map(Number)
  const lngNeighbourOffset = shardIdForCellId(`${aLatBucket}_${aLngBucket - 1}`) === shardIdForCellId(fineCellIdA) ? -1 : 1
  const fineCellIdB = `${aLatBucket}_${aLngBucket + lngNeighbourOffset}`
  assert.equal(
    shardIdForCellId(fineCellIdA),
    shardIdForCellId(fineCellIdB),
    'test setup assumption broken: these two fine cells were expected to share a shard',
  )

  const ringB = tinyRing.map(([lng, lat]) => [lng + lngNeighbourOffset * CELL_SIZE_DEG, lat])

  const touchedA = await writeParcelsToShardParts(outDir, 'england_wales', [
    { titleNumber: 'DN1', tenure: 'freehold', polygons: [tinyRing] },
  ])
  assert.equal(touchedA, 1, 'one parcel in one fine cell should touch exactly one shard')

  const touchedB = await writeParcelsToShardParts(outDir, 'england_wales', [
    { titleNumber: 'DN2', tenure: 'freehold', polygons: [ringB] },
  ])
  assert.equal(touchedB, 1)

  const shardsFinalized = await finalizeShards(outDir, 'england_wales')
  assert.equal(shardsFinalized, 1, 'both parcels landed in the same shard, so finalizing should produce exactly one file')

  // The _parts directory should be gone after finalizing.
  await assert.rejects(readdir(join(outDir, 'england_wales', '_parts')))

  const shardId = shardIdForCellId(fineCellIdA)
  const filePath = join(outDir, 'england_wales', `${shardId}.json.gz`)
  const lines = gunzipSync(await readFile(filePath))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

  assert.equal(lines.length, 2, 'both features should appear as separate NDJSON lines')
  const lineA = lines.find((l) => l.properties.title_number === 'DN1')
  const lineB = lines.find((l) => l.properties.title_number === 'DN2')
  assert.equal(lineA.c, fineCellIdA)
  assert.equal(lineB.c, fineCellIdB)
  assert.equal(lineA.geometry.type, 'MultiPolygon')
  assert.equal(lineA.properties.tenure, 'freehold')

  // Coordinate pass-through: confirm the written coordinate is still
  // (within floating point noise) the original input coordinate.
  const outLng = lineA.geometry.coordinates[0][0][0][0]
  assert.ok(Math.abs(outLng - tinyRing[0][0]) < 1e-9)

  // finalizeShards on a nation with nothing written should no-op rather
  // than throw (the build scripts always call it, dry-run or not having
  // already decided not to call it on dry runs, but a nation with zero
  // parcels anywhere — e.g. Scotland during an --council=... EW-only run
  // sharing the same outDir — must still be safe to finalize).
  const shardsFinalizedEmpty = await finalizeShards(outDir, 'scotland')
  assert.equal(shardsFinalizedEmpty, 0)

  console.log('PASS: cell/shard id math is consistent, and writeParcelsToShardParts/finalizeShards produce correct gzipped NDJSON shards.')
} finally {
  await rm(outDir, { recursive: true, force: true })
}
