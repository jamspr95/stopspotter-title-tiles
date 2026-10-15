#!/usr/bin/env node
// StopSpotter — England & Wales title tile BUILD (on-demand lookup design,
// see docs/TITLE_BOUNDARY_API_PLAN.md). This is sync-title-boundaries-ew.mjs
// with its destination swapped: instead of upserting parcels into Postgres
// (which is the bulk-load design that filled the disk and caused the
// outage this plan replaces), it writes them into per-shard NDJSON parts
// files via scripts/lib/titleTiles.mjs's writeParcelsToShardParts() (one
// call per council, append-only, never read back — see that module's own
// header comment for the real OOM incident this avoids), then gzips each
// shard once via finalizeShards() after every council has been processed.
// A later workflow step publishes the resulting .json.gz files as GitHub
// Release assets. No Supabase client, no SUPABASE_SERVICE_ROLE_KEY, no
// Postgres involved anywhere in this script — that's the whole point.
//
// Every download-scraping and GML-parsing concern (the HMLR download page's
// table-row scrape, the cookie-walk, the zip/GML extraction, the LR:*
// element-name tolerance) is identical to sync-title-boundaries-ew.mjs and
// deliberately NOT re-explained here — see that script's own header
// comment for the "why" on all of it, and docs/SETUP.md §15. Only this
// file's own header comment below covers what's actually different.
//
// Usage:
//   node scripts/build-title-tiles-ew.mjs --all [--dry-run] [--out=./title-tiles-build]
//   node scripts/build-title-tiles-ew.mjs --council="Exeter" [--dry-run]
//   node scripts/build-title-tiles-ew.mjs --dir=./downloads/ew [--council="Exeter"] [--dry-run]
//
// --dry-run here means "parse and log, write no tile files" (there's no
// database to touch either way) — same meaning as the sync script's flag,
// kept for the same manual-verification workflow before trusting --all.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchWithCookieJar } from './lib/httpWithCookies.mjs'
import {
  describeGmlStructure,
  extractGmlBuffers,
  extractGmlTexts,
  extractParcels,
  extractParcelsFromLargeBuffer,
  isStringTooLongError,
} from './lib/inspireGml.mjs'
import { withRetries } from './lib/retry.mjs'
import { finalizeShards, writeParcelsToShardParts } from './lib/titleTiles.mjs'

/**
 * Parses one council's raw download into parcels, trying the normal
 * (fast, proven) whole-string path first and falling back to the
 * streaming parser ONLY on the specific oversized-file failure it exists
 * to fix — every other error (a real schema mismatch, a corrupt
 * download) still surfaces exactly as before, unchanged.
 */
function parseGmlBuffer(name, buffer) {
  try {
    const gmlTexts = extractGmlTexts(buffer)
    return { parcels: gmlTexts.flatMap(extractParcels), fileCount: gmlTexts.length, streamed: false, sampleText: gmlTexts[0] }
  } catch (err) {
    if (!isStringTooLongError(err)) throw err
    console.log(`  ${name}'s GML is too large for one JS string — falling back to the streaming parser`)
    const gmlBuffers = extractGmlBuffers(buffer)
    const parcels = gmlBuffers.flatMap((buf) => extractParcelsFromLargeBuffer(buf))
    return { parcels, fileCount: gmlBuffers.length, streamed: true, sampleText: null }
  }
}

const LOCAL_FILE_EXTENSIONS = ['.gml', '.gml.gz', '.zip', '.xml']
const DEFAULT_OUT_DIR = './title-tiles-build'

/** A manually-downloaded council file's name, minus whichever extension it has. */
function stripKnownExtension(filename) {
  const match = LOCAL_FILE_EXTENSIONS.find((ext) => filename.toLowerCase().endsWith(ext))
  return match ? filename.slice(0, -match.length) : filename
}

async function findLocalFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile() && LOCAL_FILE_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext)))
  if (files.length === 0) {
    throw new Error(
      `No .gml/.gml.gz/.zip/.xml files found in ${dir} — check you saved the downloaded council file(s) there. See docs/SETUP.md §15.`,
    )
  }
  return files.map((e) => ({ name: stripKnownExtension(e.name), path: join(dir, e.name) }))
}

const DOWNLOAD_PAGE = 'https://use-land-property-data.service.gov.uk/datasets/inspire/download'
const MIN_EXPECTED_COUNCILS = 300 // England + Wales has ~380 local authorities — fail loudly if the page structure changed and far fewer links were found

async function findCouncilLinks() {
  const res = await fetchWithCookieJar(DOWNLOAD_PAGE, { headers: { 'User-Agent': 'StopSpotter-title-tiles-build (AireStop)' } })
  if (!res.ok) throw new Error(`Failed to load the download page (${res.status})`)
  const html = await res.text()

  // Identical scrape to sync-title-boundaries-ew.mjs's findCouncilLinks —
  // see that function's comment for why this is a row-boundary regex, not
  // a full HTML parse, and why MIN_EXPECTED_COUNCILS exists.
  const rowPattern = /<th[^>]*scope="row"[^>]*>\s*([^<]+?)\s*<\/th>[\s\S]*?href="([^"]+?\.zip)"/gi
  const links = []
  let match
  while ((match = rowPattern.exec(html))) {
    const name = match[1].replace(/\s+/g, ' ').trim()
    const href = match[2].startsWith('http') ? match[2] : new URL(match[2], DOWNLOAD_PAGE).toString()
    if (name) links.push({ name, href })
  }

  if (links.length === 0) {
    const allHrefs = [...html.matchAll(/<a[^>]+href="([^"]+)"/gi)].map((m) => m[1])
    const uniqueHrefs = [...new Set(allHrefs)]
    const zipIndex = html.search(/\.zip/i)
    throw new Error(
      [
        `Parsed zero council rows from the download page (${html.length} bytes of HTML) — the page's structure has changed again and this scraper's row regex needs updating, not a stale page.`,
        `Total <a href> tags found: ${allHrefs.length} (${uniqueHrefs.length} unique). Sample hrefs:`,
        ...uniqueHrefs.slice(0, 25).map((h) => `  ${h}`),
        zipIndex === -1
          ? 'No case-insensitive ".zip" substring found anywhere in the page at all.'
          : `First ".zip" mention, with context:\n${html.slice(Math.max(0, zipIndex - 400), zipIndex + 100)}`,
      ].join('\n'),
    )
  }
  return links
}

async function buildOneCouncil(outDir, name, getBytes, dryRun) {
  console.log(`Reading ${name}...`)
  // Retries only the download — confirmed from a real run (Oct 2026)
  // that several councils failed with a bare "fetch failed" and
  // nothing else, the signature of a one-off network blip, not a
  // parsing bug. Parsing failures below are never retried: those are
  // reproducible (a schema assumption that's wrong for this file, or a
  // file too large for one JS string), and retrying would just waste
  // time repeating the same failure.
  const buffer = await withRetries(getBytes)
  const { parcels, fileCount, streamed, sampleText } = parseGmlBuffer(name, buffer)
  console.log(`  parsed ${parcels.length} parcels (from ${fileCount} GML file${fileCount === 1 ? '' : 's'}${streamed ? ', streamed' : ''})`)
  if (parcels.length === 0) {
    throw new Error(
      [
        `${name}: parsed zero parcels from a non-empty download — the parser's assumptions about HMLR's schema are likely wrong for this file. Stopping rather than silently writing nothing into the tiles. See scripts/sync-title-boundaries-ew.mjs's header comment.`,
        sampleText ? describeGmlStructure(sampleText) : '(streamed parse — no single sample text available; re-run without triggering the streaming fallback to get a describeGmlStructure preview, e.g. against a --dir copy if the file is small enough once decompressed)',
      ].join('\n'),
    )
  }
  console.log(`  sample: title ${parcels[0].titleNumber}, ${parcels[0].polygons[0].length} points`)

  if (dryRun) return 0

  const shardsTouched = await writeParcelsToShardParts(
    outDir,
    'england_wales',
    parcels.map((p) => ({ titleNumber: p.titleNumber, tenure: 'freehold', polygons: p.polygons })),
  )
  console.log(`  appended into ${shardsTouched} shard part file(s)`)
  return parcels.length
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const councilArg = args.find((a) => a.startsWith('--council='))?.split('=')[1]
  const dirArg = args.find((a) => a.startsWith('--dir='))?.split('=')[1]
  const outArg = args.find((a) => a.startsWith('--out='))?.split('=')[1]
  const all = args.includes('--all')
  const outDir = outArg ?? DEFAULT_OUT_DIR

  if (!councilArg && !all && !dirArg) {
    console.error(
      'Usage: node scripts/build-title-tiles-ew.mjs --all | --council="Name" | --dir="./downloads/ew" [--council="Name"] [--dry-run] [--out=./title-tiles-build]',
    )
    process.exit(1)
  }

  // targets: [{ name, getBytes }] — getBytes fetches a live link or reads
  // a manually-downloaded local file, depending on --dir. Everything past
  // this point (parsing, tile-writing, error handling) is identical either way.
  let targets
  if (dirArg) {
    console.log(`Reading council files from ${dirArg}...`)
    const files = await findLocalFiles(dirArg)
    console.log(`Found ${files.length} file(s).`)
    targets = files.map(({ name, path }) => ({
      name,
      getBytes: () => readFile(path),
    }))
  } else {
    console.log('Finding council download links...')
    const links = await findCouncilLinks()
    console.log(`Found ${links.length} links.`)
    if (!councilArg && links.length < MIN_EXPECTED_COUNCILS) {
      throw new Error(
        `Only found ${links.length} council links, expected ${MIN_EXPECTED_COUNCILS}+ — the download page's structure has likely changed (it may now require signing in — see docs/SETUP.md §15's --dir fallback) and this scraper needs updating, not a partial run.`,
      )
    }
    targets = links.map(({ name, href }) => ({
      name,
      getBytes: async () => {
        const res = await fetchWithCookieJar(href, { headers: { 'User-Agent': 'StopSpotter-title-tiles-build (AireStop)' } })
        if (!res.ok) throw new Error(`Failed to fetch ${name} (${res.status})`)
        return Buffer.from(await res.arrayBuffer())
      },
    }))
  }

  if (councilArg) {
    targets = targets.filter((t) => t.name.toLowerCase().includes(councilArg.toLowerCase()))
  }
  if (targets.length === 0) {
    throw new Error(`No council matched "${councilArg}".`)
  }

  if (!dryRun) console.log(`Writing tiles to ${outDir}/england_wales/`)

  let totalParcels = 0
  const failures = []
  for (const { name, getBytes } of targets) {
    try {
      totalParcels += await buildOneCouncil(outDir, name, getBytes, dryRun)
    } catch (err) {
      console.error(`  FAILED (${name}): ${err.message}`)
      failures.push({ name, error: err.message })
    }
  }

  console.log(`Done. ${totalParcels} parcels processed across ${targets.length - failures.length}/${targets.length} councils.`)

  if (!dryRun) {
    console.log('Finalising shards (gzipping accumulated parts files)...')
    const shardsFinalized = await finalizeShards(outDir, 'england_wales')
    console.log(`Finalized ${shardsFinalized} shard file(s).`)
  }

  if (failures.length > 0) {
    console.error(`${failures.length} councils failed:`, failures.map((f) => f.name).join(', '))
    process.exit(1)
  }
}

await main()
