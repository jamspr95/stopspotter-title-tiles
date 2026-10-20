// StopSpotter — Douglas-Peucker simplification for one polygon ring.
//
// Real incident (20 Oct 2026): a Scottish title checked directly
// (SCT0002609904) is one line of NDJSON output but 1.19MB by itself — 232
// disjoint MultiPolygon members (a scattered title, e.g. common grazing
// rights spread across a county), several individual rings 200-340 points
// long. The existing "indicative extent, not the legal boundary" caveat
// (0015_title_boundaries.sql) already accepts the stored geometry isn't
// survey-exact, so shaving redundant near-collinear vertices off an
// already-indicative outline costs nothing real while cutting the worst
// offenders' size substantially. Ring tagging for which fine cell(s) a
// ring belongs to (titleTiles.mjs's cellIdsForRings) must always run
// against the ORIGINAL ring, never a simplified one — simplification can
// only remove points whose own deviation is small, so it can never move a
// ring's true bounding box, but there's no reason to rely on that subtlety
// at every call site when it's just as easy to simplify only the
// geometry that gets stored, after cell membership is already decided.
//
// Deliberately dependency-free (no npm package) — same tradeoff as every
// other tiny geometry helper in this module's sibling titleTiles.mjs; see
// that file's own header comment for why.

/** Squared perpendicular distance from `point` to the infinite line through `a`/`b`, in whatever units the input coordinates are in (here, degrees). Squared to avoid a sqrt per candidate point. */
function perpendicularDistanceSq(point, a, b) {
  const [px, py] = point
  const [ax, ay] = a
  const [bx, by] = b
  const dx = bx - ax
  const dy = by - ay
  const lineLengthSq = dx * dx + dy * dy
  if (lineLengthSq === 0) {
    // a and b are the same point (happens at a closed ring's own
    // start/end anchor) — fall back to plain point-to-point distance.
    const ddx = px - ax
    const ddy = py - ay
    return ddx * ddx + ddy * ddy
  }
  const cross = (px - ax) * dy - (py - ay) * dx
  return (cross * cross) / lineLengthSq
}

/**
 * Standard iterative Douglas-Peucker, run directly on the closed ring
 * (first point === last point) — the two endpoints passed to the
 * algorithm are ring[0] and ring[ring.length-1], which are the same
 * point, so they're always both kept and ring closure is preserved for
 * free, with no special-casing for "closed vs open" needed.
 *
 * toleranceDeg: a point is dropped if its perpendicular distance from the
 * line between its surviving neighbours is under this, in degrees.
 * Iterative (explicit stack), not recursive, so an unusually long ring
 * (hundreds of points, the exact case this exists for) can't blow the
 * call stack.
 */
export function simplifyRing(ring, toleranceDeg) {
  if (ring.length <= 3) return ring // a single edge (plus closing point) can't be simplified further

  const toleranceSq = toleranceDeg * toleranceDeg
  const keep = new Uint8Array(ring.length)
  keep[0] = 1
  keep[ring.length - 1] = 1

  const stack = [[0, ring.length - 1]]
  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop()
    if (endIdx - startIdx < 2) continue // no point strictly between them

    let maxDistSq = -1
    let maxIdx = -1
    for (let i = startIdx + 1; i < endIdx; i++) {
      const distSq = perpendicularDistanceSq(ring[i], ring[startIdx], ring[endIdx])
      if (distSq > maxDistSq) {
        maxDistSq = distSq
        maxIdx = i
      }
    }

    if (maxDistSq > toleranceSq) {
      keep[maxIdx] = 1
      stack.push([startIdx, maxIdx], [maxIdx, endIdx])
    }
  }

  const simplified = []
  for (let i = 0; i < ring.length; i++) {
    if (keep[i]) simplified.push(ring[i])
  }
  // A valid polygon ring needs at least 3 distinct points plus the
  // closing repeat (4 entries) — fall back to the original rather than
  // hand back something point-in-polygon can't sensibly test against.
  return simplified.length < 4 ? ring : simplified
}
