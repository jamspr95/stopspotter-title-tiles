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
  NUM_RELEASE_PARTITIONS,
  finalizeShards,
  releasePartitionForShardId,
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

// shardIdForCellId: at FINE_CELLS_PER_SHARD=1 a shard IS a fine cell —
// every cell id must map to its own, distinct shard id (not grouped with
// any neighbour). This is the one invariant that changed from this
// module's earlier (grouped) design; see FINE_CELLS_PER_SHARD's own
// comment for why grouping was removed entirely.
assert.equal(FINE_CELLS_PER_SHARD, 1)
assert.equal(shardIdForCellId('500_-40'), '500_-40')
assert.notEqual(shardIdForCellId('500_-40'), shardIdForCellId('500_-39'))
assert.notEqual(shardIdForCellId('500_-40'), shardIdForCellId('501_-40'))

// releasePartitionForShardId: every partition index actually used must
// be in range, and two shards far enough apart in latitude to land in
// different bands (not just adjacent — adjacent bands can share a
// partition by design, see that function's own comment on why it's a
// modulo split) must be able to land in different partitions.
for (let lat = -5; lat <= 5; lat++) {
  const p = releasePartitionForShardId(`${lat}_0`)
  assert.ok(p >= 0 && p < NUM_RELEASE_PARTITIONS, `partition ${p} out of range for lat ${lat}`)
}
const partitionsSeen = new Set()
for (let lat = 500; lat < 500 + NUM_RELEASE_PARTITIONS * 5; lat++) {
  partitionsSeen.add(releasePartitionForShardId(`${lat}_0`))
}
assert.equal(partitionsSeen.size, NUM_RELEASE_PARTITIONS, 'a run of consecutive latitudes should spread across every partition')

// writeParcelsToShardParts + finalizeShards: two parcels in the SAME fine
// cell (two titles can genuinely share one, e.g. adjoining small plots)
// must survive as two separate lines in one shard file, with no
// accidental overwrite.
const outDir = await mkdtemp(join(tmpdir(), 'title-tiles-test-'))
try {
  const fineCellIdA = cellIdForPoint(50.715, -3.535) // tinyRing's cell
  const ringB = tinyRing.map(([lng, lat]) => [lng + 0.001, lat]) // tiny nudge, same fine cell
  assert.equal(cellIdForPoint(50.7151, -3.534), fineCellIdA, 'test setup assumption broken: ringB was expected to stay in the same fine cell')

  const touchedA = await writeParcelsToShardParts(outDir, 'england_wales', [
    { titleNumber: 'DN1', tenure: 'freehold', polygons: [tinyRing] },
  ])
  assert.equal(touchedA, 1, 'one parcel in one fine cell should touch exactly one shard')

  const touchedB = await writeParcelsToShardParts(outDir, 'england_wales', [
    { titleNumber: 'DN2', tenure: 'freehold', polygons: [ringB] },
  ])
  assert.equal(touchedB, 1)

  // A third parcel, scattered across two DISJOINT rings far apart (the
  // real incident this module's per-ring tagging fixes — see
  // writeParcelsToShardParts' own comment) — a cell strictly between the
  // two rings, overlapping neither, must NOT receive a line for it, even
  // though the old whole-parcel-bounding-box design would have tagged
  // every cell in between.
  const farRingA = [
    [-3.54, 50.0],
    [-3.53, 50.0],
    [-3.53, 50.01],
    [-3.54, 50.01],
    [-3.54, 50.0],
  ]
  const farRingB = [
    [-3.54, 52.0],
    [-3.53, 52.0],
    [-3.53, 52.01],
    [-3.54, 52.01],
    [-3.54, 52.0],
  ]
  const betweenCellId = cellIdForPoint(51.0, -3.535) // roughly midway in latitude between the two rings
  const touchedScattered = await writeParcelsToShardParts(outDir, 'england_wales', [
    { titleNumber: 'SCATTERED1', tenure: 'freehold', polygons: [farRingA, farRingB] },
  ])
  assert.equal(touchedScattered, 2, 'a scattered title should only touch shards near its OWN rings, not everything in between')
  const betweenShardPath = join(outDir, 'england_wales', '_parts', `${shardIdForCellId(betweenCellId)}.ndjson`)
  await assert.rejects(
    readFile(betweenShardPath),
    'a cell strictly between a scattered title\'s two disjoint rings must not get a part file for it at all',
  )

  const shardsFinalized = await finalizeShards(outDir, 'england_wales')
  assert.equal(
    shardsFinalized,
    3,
    'fineCellIdA\'s shard (DN1+DN2) plus the two scattered rings\' own separate shards = 3 files',
  )

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
  assert.equal(lineB.c, fineCellIdA)
  assert.equal(lineA.geometry.type, 'MultiPolygon')
  assert.equal(lineA.geometry.coordinates.length, 1, 'each written feature now carries exactly one ring (per-ring tagging), never a parcel\'s other members')
  assert.equal(lineA.properties.tenure, 'freehold')

  // Coordinate pass-through: confirm the written coordinate is still
  // (within floating point noise) the original input coordinate — this
  // ring is far too small (its own corners deviate hugely from a
  // straight line between neighbours) for simplifyRing's small tolerance
  // to touch any of its points.
  const outLng = lineA.geometry.coordinates[0][0][0][0]
  assert.ok(Math.abs(outLng - tinyRing[0][0]) < 1e-9)

  // finalizeShards on a nation with nothing written should no-op rather
  // than throw (the build scripts always call it, dry-run or not having
  // already decided not to call it on dry runs, but a nation with zero
  // parcels anywhere — e.g. Scotland during an --council=... EW-only run
  // sharing the same outDir — must still be safe to finalize).
  const shardsFinalizedEmpty = await finalizeShards(outDir, 'scotland')
  assert.equal(shardsFinalizedEmpty, 0)

  console.log('PASS: cell/shard/partition id math is consistent, and writeParcelsToShardParts/finalizeShards produce correct gzipped NDJSON shards with per-ring tagging.')
} finally {
  await rm(outDir, { recursive: true, force: true })
}
