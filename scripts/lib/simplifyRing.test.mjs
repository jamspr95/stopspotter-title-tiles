import assert from 'node:assert/strict'
import { simplifyRing } from './simplifyRing.mjs'

// A rectangle is already minimal (every corner deviates a lot from its
// neighbours) — a small tolerance must leave it untouched, exactly, not
// just approximately (no floating-point drift from points that are kept).
const rectangle = [
  [-3.54, 50.71],
  [-3.53, 50.71],
  [-3.53, 50.72],
  [-3.54, 50.72],
  [-3.54, 50.71],
]
assert.deepEqual(simplifyRing(rectangle, 0.00003), rectangle)

// A near-straight edge with small zig-zag noise between two real corners:
// the noisy points should collapse away under a tolerance bigger than the
// noise, but the two genuine corners must survive.
const noisyEdge = [
  [0, 0],
  [1, 0.0001],
  [2, -0.0001],
  [3, 0.0001],
  [4, 0], // genuine corner
  [4, 1], // genuine corner
  [0, 1],
  [0, 0],
]
const simplifiedNoisy = simplifyRing(noisyEdge, 0.001)
assert.ok(simplifiedNoisy.length < noisyEdge.length, 'noisy near-collinear points should be dropped')
assert.deepEqual(simplifiedNoisy[0], [0, 0])
assert.deepEqual(simplifiedNoisy[simplifiedNoisy.length - 1], [0, 0])
assert.ok(simplifiedNoisy.some(([x, y]) => x === 4 && y === 0), 'the real corner at (4,0) must survive')
assert.ok(simplifiedNoisy.some(([x, y]) => x === 4 && y === 1), 'the real corner at (4,1) must survive')

// Zero tolerance: only exactly-collinear points can ever be dropped — a
// shape with no exactly-collinear points comes back unchanged.
assert.deepEqual(simplifyRing(rectangle, 0), rectangle)

// A triangle (3 distinct points + closing repeat = 4 entries) is already
// at the floor this module enforces and must never be simplified away to
// nothing, however large the tolerance.
const triangle = [
  [0, 0],
  [10, 0],
  [5, 10],
  [0, 0],
]
assert.deepEqual(simplifyRing(triangle, 1000), triangle)

// A ring too short to simplify (a single edge) is returned as-is.
const degenerate = [
  [0, 0],
  [1, 1],
  [0, 0],
]
assert.deepEqual(simplifyRing(degenerate, 1000), degenerate)

console.log('PASS: simplifyRing keeps real corners and ring closure, drops noise, never collapses below a valid ring.')
