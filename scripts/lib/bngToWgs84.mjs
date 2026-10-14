// British National Grid (OSGB36, EPSG:27700) -> WGS84 lat/lng.
//
// Both England/Wales's INSPIRE Index Polygons and Scotland's Cadastral
// Parcels are Ordnance-Survey-derived and published in the National Grid,
// not WGS84 — this has to run before anything gets near a `geography(4326)`
// column, or every title boundary lands a couple of hundred kilometres off.
//
// Standard three-step OS algorithm (Transverse Mercator inverse projection
// on the Airy 1830 ellipsoid -> OSGB36 lat/lon, then the published 7-parameter
// Helmert transform to WGS84), using the constants in Ordnance Survey's own
// "A guide to coordinate systems in Great Britain" — the same approach (and
// the same small-Helmert accuracy tradeoff: a few metres, not the
// centimetre-accurate OSTN15 grid transform) as every other widely-used open
// implementation of this conversion. A few metres of error is nothing next
// to "indicative extent" to begin with (see 0015_title_boundaries.sql).
//
// Verified against Ordnance Survey's own published test point (from that
// guide): easting 651409.903, northing 313177.270 -> approximately
// 52.657977°N, 1.717925°E — see scripts/lib/bngToWgs84.test.mjs.

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

// Airy 1830 ellipsoid (OSGB36)
const A = 6377563.396
const B = 6356256.909
const F0 = 0.9996012717 // scale factor on central meridian
const LAT0 = 49 * DEG // true origin latitude
const LON0 = -2 * DEG // true origin longitude
const N0 = -100000 // true origin northing
const E0 = 400000 // true origin easting
const ECC2 = 1 - (B * B) / (A * A) // eccentricity squared

function bngToOsgb36LatLon(easting, northing) {
  let lat = LAT0
  let M = 0
  const n = (A - B) / (A + B)
  const n2 = n * n
  const n3 = n * n * n

  let iterations = 0
  do {
    lat = (northing - N0 - M) / (A * F0) + lat

    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - LAT0)
    const Mb = (3 * n + 3 * n * n + (21 / 8) * n3) * Math.sin(lat - LAT0) * Math.cos(lat + LAT0)
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - LAT0)) * Math.cos(2 * (lat + LAT0))
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - LAT0)) * Math.cos(3 * (lat + LAT0))
    M = B * F0 * (Ma - Mb + Mc - Md)
    iterations++
    if (process.env.BNG_DEBUG) console.log('iter', iterations, 'lat', lat * RAD, 'M', M, 'residual', northing - N0 - M)
    if (iterations > 50) throw new Error(`bngToWgs84: latitude iteration failed to converge (easting=${easting}, northing=${northing})`)
  } while (Math.abs(northing - N0 - M) >= 0.00001)

  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const tanLat = Math.tan(lat)
  const tan2lat = tanLat * tanLat
  const tan4lat = tan2lat * tan2lat

  const nu = (A * F0) / Math.sqrt(1 - ECC2 * sinLat * sinLat)
  const rho = (A * F0 * (1 - ECC2)) / Math.pow(1 - ECC2 * sinLat * sinLat, 1.5)
  const eta2 = nu / rho - 1

  const VII = tanLat / (2 * rho * nu)
  const VIII = (tanLat / (24 * rho * Math.pow(nu, 3))) * (5 + 3 * tan2lat + eta2 - 9 * tan2lat * eta2)
  const IX = (tanLat / (720 * rho * Math.pow(nu, 5))) * (61 + 90 * tan2lat + 45 * tan4lat)
  const X = 1 / (cosLat * nu)
  const XI = (1 / (6 * cosLat * Math.pow(nu, 3))) * (nu / rho + 2 * tan2lat)
  const XII = (1 / (120 * cosLat * Math.pow(nu, 5))) * (5 + 28 * tan2lat + 24 * tan4lat)
  const XIIA =
    (1 / (5040 * cosLat * Math.pow(nu, 7))) * (61 + 662 * tan2lat + 1320 * tan4lat + 720 * tan2lat * tan4lat)

  const dE = easting - E0
  const latRad = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6
  const lonRad = LON0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7

  return { lat: latRad * RAD, lon: lonRad * RAD }
}

// Geodetic (lat/lon/height) -> cartesian (X,Y,Z), given ellipsoid a/b.
function geodeticToCartesian(lat, lon, h, a, b) {
  const latR = lat * DEG
  const lonR = lon * DEG
  const e2 = 1 - (b * b) / (a * a)
  const sinLat = Math.sin(latR)
  const cosLat = Math.cos(latR)
  const nu = a / Math.sqrt(1 - e2 * sinLat * sinLat)
  return {
    x: (nu + h) * cosLat * Math.cos(lonR),
    y: (nu + h) * cosLat * Math.sin(lonR),
    z: (nu * (1 - e2) + h) * sinLat,
  }
}

// Helmert transform OSGB36 (Airy 1830) cartesian -> WGS84 cartesian.
// Published OS small Helmert transform parameters.
function helmertOsgb36ToWgs84(x, y, z) {
  const tx = 446.448
  const ty = -125.157
  const tz = 542.06
  const s = -20.4894 / 1e6 // ppm -> scale factor
  const rx = (0.1502 / 3600) * DEG
  const ry = (0.247 / 3600) * DEG
  const rz = (0.8421 / 3600) * DEG

  return {
    x: tx + x * (1 + s) - y * rz + z * ry,
    y: ty + x * rz + y * (1 + s) - z * rx,
    z: tz - x * ry + y * rx + z * (1 + s),
  }
}

// Cartesian -> geodetic (WGS84 ellipsoid) — iterative, converges in a
// handful of passes for anything near the Earth's surface.
function cartesianToGeodetic(x, y, z, a, b) {
  const e2 = 1 - (b * b) / (a * a)
  const p = Math.sqrt(x * x + y * y)
  let lat = Math.atan2(z, p * (1 - e2))
  let nu = a / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat))

  for (let i = 0; i < 10; i++) {
    const prevLat = lat
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p)
    nu = a / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat))
    if (Math.abs(lat - prevLat) < 1e-12) break
  }

  const lon = Math.atan2(y, x)
  return { lat: lat * RAD, lon: lon * RAD }
}

const WGS84_A = 6378137.0
const WGS84_B = 6356752.314245

/** British National Grid easting/northing (metres) -> { lat, lng } in WGS84 degrees. */
export function bngToWgs84(easting, northing) {
  const osgb36 = bngToOsgb36LatLon(easting, northing)
  const cartesian = geodeticToCartesian(osgb36.lat, osgb36.lon, 0, A, B)
  const wgs84Cartesian = helmertOsgb36ToWgs84(cartesian.x, cartesian.y, cartesian.z)
  const wgs84 = cartesianToGeodetic(wgs84Cartesian.x, wgs84Cartesian.y, wgs84Cartesian.z, WGS84_A, WGS84_B)
  return { lat: wgs84.lat, lng: wgs84.lon }
}
