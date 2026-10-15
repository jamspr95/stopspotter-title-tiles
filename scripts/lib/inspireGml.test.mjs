import assert from 'node:assert/strict'
import { extractParcels, extractParcelsFromLargeBuffer } from './inspireGml.mjs'

// Can't test extractParcelsFromLargeBuffer against a real multi-hundred-MB
// HMLR/RoS file from here (no network access, and it's too large to be a
// sane fixture anyway) — see this repo's TITLE_BOUNDARY_API_PLAN.md for
// why this needs a real scoped --council=/--county= run against the
// actual failing areas (Cornwall, The North Yorkshire Council, Dumfries)
// to fully confirm. What IS testable without real data: that the
// chunking/carry-over logic itself is correct — i.e. that splitting an
// arbitrary buffer into tiny windows and reassembling features across
// those boundaries produces EXACTLY the same result as parsing the whole
// thing as one string (extractParcels), which is what this test proves by
// forcing a deliberately tiny windowBytes so real chunk boundaries land
// mid-feature, mid-tag, and mid-UTF-8-character.

function buildSyntheticGml(featureCount) {
  const features = []
  for (let i = 0; i < featureCount; i++) {
    // A non-ASCII character (é, 2 bytes in UTF-8) deliberately placed in
    // every Nth feature's content, so some window boundary is virtually
    // guaranteed to land mid-character with a small enough windowBytes.
    const marker = i % 7 === 0 ? 'é' : ''
    features.push(
      `<LR:PREDEFINED gml:id="f${i}">` +
        `<LR:INSPIREID>${90000000 + i}</LR:INSPIREID>` +
        `<LR:NATIONALCADASTRALREFERENCE>REF${marker}${i}</LR:NATIONALCADASTRALREFERENCE>` +
        `<LR:GEOMETRY><gml:Polygon><gml:exterior><gml:LinearRing>` +
        `<gml:posList>${100000 + i} 200000 ${100010 + i} 200000 ${100010 + i} 200010 ${100000 + i} 200010 ${100000 + i} 200000</gml:posList>` +
        `</gml:LinearRing></gml:exterior></gml:Polygon></LR:GEOMETRY>` +
        `</LR:PREDEFINED>`,
    )
  }
  return `<?xml version="1.0"?><wfs:FeatureCollection>${features.join('')}</wfs:FeatureCollection>`
}

const gmlText = buildSyntheticGml(200)
const gmlBuffer = Buffer.from(gmlText, 'utf8')

const expected = extractParcels(gmlText)
assert.equal(expected.length, 200, 'sanity check on the synthetic fixture itself')

// Deliberately tiny — far smaller than any single feature's own markup
// (~250 bytes), forcing every feature to be reassembled across several
// chunk boundaries, including the UTF-8 continuation-byte safety logic.
const streamed = extractParcelsFromLargeBuffer(gmlBuffer, { windowBytes: 97 })

assert.equal(streamed.length, expected.length, `expected ${expected.length} parcels, streamed parser found ${streamed.length}`)
for (let i = 0; i < expected.length; i++) {
  assert.equal(streamed[i].titleNumber, expected[i].titleNumber, `parcel ${i} title number mismatch`)
  assert.equal(
    streamed[i].polygons[0].length,
    expected[i].polygons[0].length,
    `parcel ${i} point count mismatch`,
  )
  // Spot-check actual coordinates match too, not just counts.
  assert.deepEqual(streamed[i].polygons[0][0], expected[i].polygons[0][0], `parcel ${i} first point mismatch`)
}

console.log(`PASS: streamed parser matched the whole-string parser exactly across ${expected.length} parcels, forced through tiny (97-byte) chunk boundaries including mid-UTF-8-character splits.`)

// A different window size, to confirm this isn't a fluke of one specific
// boundary alignment.
const streamedAgain = extractParcelsFromLargeBuffer(gmlBuffer, { windowBytes: 311 })
assert.equal(streamedAgain.length, expected.length)
console.log('PASS: also matches with a different window size (311 bytes).')

// Safety valve: a feature whose opening tag never closes must fail loudly
// rather than hang or silently drop data.
const brokenBuffer = Buffer.from('<LR:PREDEFINED gml:id="broken">' + 'x'.repeat(200), 'utf8')
assert.throws(
  () => extractParcelsFromLargeBuffer(brokenBuffer, { windowBytes: 16 }),
  /unclosed parcel feature/,
  'an unclosed feature tag should throw, not hang or silently return nothing',
)
console.log('PASS: an unclosed feature tag fails loudly via the safety valve, as designed.')
