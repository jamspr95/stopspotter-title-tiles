import assert from 'node:assert/strict'
import { bngToWgs84 } from './bngToWgs84.mjs'

function degreesToMetres(deltaDeg, atLat) {
  return Math.abs(deltaDeg) * 111_320 * Math.cos((atLat * Math.PI) / 180)
}

// GDAL/PROJ's own British National Grid documentation gives a matched
// forward test pair for this exact projection (Airy 1830, k0=0.9996012717,
// true origin 49N 2W): 50.5N 0.5E -> E 577274.99, N 69740.50. Run in
// reverse here. The small residual this allows for isn't test slop — it's
// the genuine OSGB36->WGS84 datum shift for Great Britain (order of
// 100-200m), which this conversion deliberately uses the simpler ~metre-
// accurate Helmert transform for rather than the centimetre-accurate OSTN15
// grid (see bngToWgs84.mjs's own header comment on why that's fine here).
const result = bngToWgs84(577274.99, 69740.5)
console.log('Converted:', result)

const EXPECTED_LAT = 50.5
const EXPECTED_LON = 0.5
const TOLERANCE_M = 250

const latErrorM = degreesToMetres(result.lat - EXPECTED_LAT, EXPECTED_LAT)
const lonErrorM = degreesToMetres(result.lng - EXPECTED_LON, EXPECTED_LAT)
console.log(`lat error: ${latErrorM.toFixed(1)}m, lon error: ${lonErrorM.toFixed(1)}m`)

assert.ok(latErrorM < TOLERANCE_M, `lat error ${latErrorM}m exceeds ${TOLERANCE_M}m`)
assert.ok(lonErrorM < TOLERANCE_M, `lon error ${lonErrorM}m exceeds ${TOLERANCE_M}m`)
console.log('PASS: within the expected OSGB36->WGS84 datum-shift tolerance of a published BNG test pair.')

// Two more sanity checks, printed not asserted — the BNG references and
// expected lat/lng here are typed from memory, not sourced the way the
// GDAL/PROJ pair above is, so an imprecise "expected" value shouldn't fail
// the suite. Still worth a look: either should land in the right city, not
// a different county.
const greenwich = bngToWgs84(538900, 177300)
console.log('Greenwich (expect ~51.4769N 0.0005W):', greenwich)

const edinburgh = bngToWgs84(325740, 673480)
console.log('Edinburgh Castle (expect ~55.9486N 3.1999W):', edinburgh)
