#!/usr/bin/env node
// StopSpotter — Scotland title tile BUILD (on-demand lookup design, see
// docs/TITLE_BOUNDARY_API_PLAN.md). This is sync-title-boundaries-scotland.mjs
// with its destination swapped: instead of upserting parcels into Postgres,
// it writes them into per-shard NDJSON parts files via
// scripts/lib/titleTiles.mjs's writeParcelsToShardParts() (one call per
// county, append-only, never read back — see that module's own header
// comment for the real OOM incident this avoids), then gzips each shard
// once via finalizeShards() after every county has been processed. A later
// workflow step publishes the resulting .json.gz files as GitHub Release
// assets. No Supabase client, no SUPABASE_SERVICE_ROLE_KEY, no Postgres
// involved anywhere in this script.
//
// The county-list JS-bundle scraping and extractParcelsFromBytes shapefile
// parsing are identical to sync-title-boundaries-scotland.mjs — see that
// script's own header comment for the "why" (dead Atom feed domain, the
// client-rendered county picker, the GeoServer-shaped download path, the
// _bng shapefile pair, the guessed .dbf title field) and docs/SETUP.md §15.
// Only this file's own differences are covered below.
//
// Usage:
//   node scripts/build-title-tiles-scotland.mjs --all [--dry-run] [--out=./title-tiles-build]
//   node scripts/build-title-tiles-scotland.mjs --county="Lanark" [--dry-run]
//   node scripts/build-title-tiles-scotland.mjs --dir=./downloads/scotland [--county="Lanark"] [--dry-run]
//
// Scotland's Land Register has no HMLR-style freehold/leasehold tenure
// field, so tenure is always written as null here — same as the retired
// Postgres path (see 0015_title_boundaries.sql).

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchWithCookieJar } from './lib/httpWithCookies.mjs'
import { extractParcelsFromBytes } from './lib/parcelExtraction.mjs'
import { finalizeShards, writeParcelsToShardParts } from './lib/titleTiles.mjs'

const DOWNLOAD_PAGE = 'https://ros-inspire.themapcloud.com/'
const MIN_EXPECTED_COUNTIES = 25 // Scotland has 33 Registration Counties — fail loudly if far fewer entries were found
const LOCAL_FILE_EXTENSIONS = ['.gml', '.gml.gz', '.zip', '.xml']
const DEFAULT_OUT_DIR = './title-tiles-build'

/** A manually-downloaded county file's name, minus whichever extension it has. */
function stripKnownExtension(filename) {
  const match = LOCAL_FILE_EXTENSIONS.find((ext) => filename.toLowerCase().endsWith(ext))
  return match ? filename.slice(0, -match.length) : filename
}

async function findLocalFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile() && LOCAL_FILE_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext)))
  if (files.length === 0) {
    throw new Error(
      `No .gml/.gml.gz/.zip/.xml files found in ${dir} — check you saved the downloaded county file(s) there. See docs/SETUP.md §15.`,
    )
  }
  return files.map((e) => ({ name: stripKnownExtension(e.name), path: join(dir, e.name) }))
}

// Identical to sync-title-boundaries-scotland.mjs — see that script's
// header comment for how this exact literal shape was confirmed live.
const COUNTY_ARRAY_PATTERN = /\{title:"([^"]+)",description:"[^"]*",code:"([^"]+)"\}/g
const DOWNLOAD_API_PATH = 'maps/download/ros-cp.cadastralparcel/'

async function fetchText(url) {
  const res = await fetchWithCookieJar(url, { headers: { 'User-Agent': 'StopSpotter-title-tiles-build (AireStop)' } })
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`)
  return res.text()
}

async function findCountyLinks() {
  const html = await fetchText(DOWNLOAD_PAGE)
  const scriptSrcs = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]))]
  const scriptTexts = await Promise.all(
    scriptSrcs.map(async (src) => {
      try {
        return await fetchText(src.startsWith('http') ? src : new URL(src, DOWNLOAD_PAGE).toString())
      } catch {
        return ''
      }
    }),
  )
  const combined = scriptTexts.join('\n')

  const links = [...combined.matchAll(COUNTY_ARRAY_PATTERN)].map((m) => ({
    name: m[1],
    href: new URL(DOWNLOAD_API_PATH + m[2], DOWNLOAD_PAGE).toString(),
  }))

  if (links.length === 0) {
    throw new Error(
      [
        `Parsed zero counties out of ${scriptSrcs.length} JS bundle(s) (${combined.length} bytes total) — the embedded county array's shape has changed from the confirmed {title:"...",description:"...",code:"..."} literal, or the page itself has changed. This needs a fresh look (see this script's header comment for how it was found last time), not a guess.`,
      ].join('\n'),
    )
  }
  return links
}

async function fetchBytes(name, href) {
  const res = await fetchWithCookieJar(href, { headers: { 'User-Agent': 'StopSpotter-title-tiles-build (AireStop)' } })
  if (!res.ok) throw new Error(`Failed to fetch ${name} (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

async function buildOneCounty(outDir, name, getBytes, dryRun) {
  console.log(`Reading ${name}...`)
  const buffer = await getBytes()
  const parcels = await extractParcelsFromBytes(buffer)

  console.log(`  parsed ${parcels.length} parcels`)
  if (parcels.length === 0) {
    throw new Error(
      `${name}: parsed zero parcels from a non-empty download — stopping rather than silently writing nothing into the tiles. See scripts/sync-title-boundaries-scotland.mjs's header comment.`,
    )
  }
  console.log(`  sample: title ${parcels[0].titleNumber}, ${parcels[0].polygons[0].length} points`)

  if (dryRun) return 0

  const shardsTouched = await writeParcelsToShardParts(
    outDir,
    'scotland',
    parcels.map((p) => ({ titleNumber: p.titleNumber, tenure: null, polygons: p.polygons })),
  )
  console.log(`  appended into ${shardsTouched} shard part file(s)`)
  return parcels.length
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const countyArg = args.find((a) => a.startsWith('--county='))?.split('=')[1]
  const dirArg = args.find((a) => a.startsWith('--dir='))?.split('=')[1]
  const outArg = args.find((a) => a.startsWith('--out='))?.split('=')[1]
  const all = args.includes('--all')
  const outDir = outArg ?? DEFAULT_OUT_DIR

  if (!countyArg && !all && !dirArg) {
    console.error(
      'Usage: node scripts/build-title-tiles-scotland.mjs --all | --county="Name" | --dir="./downloads/scotland" [--county="Name"] [--dry-run] [--out=./title-tiles-build]',
    )
    process.exit(1)
  }

  // targets: [{ name, getBytes }] — getBytes fetches a live link or reads
  // a manually-downloaded local file, depending on --dir. Everything past
  // this point (zip/gzip detection, parsing, tile-writing) is identical either way.
  let targets
  if (dirArg) {
    console.log(`Reading county files from ${dirArg}...`)
    const files = await findLocalFiles(dirArg)
    console.log(`Found ${files.length} file(s).`)
    targets = files.map(({ name, path }) => ({ name, getBytes: () => readFile(path) }))
  } else {
    console.log('Finding county download links...')
    const links = await findCountyLinks()
    console.log(`Found ${links.length} links.`)
    if (!countyArg && links.length < MIN_EXPECTED_COUNTIES) {
      throw new Error(
        `Only found ${links.length} county links, expected ${MIN_EXPECTED_COUNTIES}+ — the download page's structure has likely changed and this scraper needs updating, not a partial run.`,
      )
    }
    targets = links.map(({ name, href }) => ({ name, getBytes: () => fetchBytes(name, href) }))
  }

  if (countyArg) {
    targets = targets.filter((t) => t.name.toLowerCase().includes(countyArg.toLowerCase()))
  }
  if (targets.length === 0) {
    throw new Error(`No county matched "${countyArg}".`)
  }

  if (!dryRun) console.log(`Writing tiles to ${outDir}/scotland/`)

  let totalParcels = 0
  const failures = []
  for (const { name, getBytes } of targets) {
    try {
      totalParcels += await buildOneCounty(outDir, name, getBytes, dryRun)
    } catch (err) {
      console.error(`  FAILED (${name}): ${err.message}`)
      failures.push({ name, error: err.message })
    }
  }

  console.log(`Done. ${totalParcels} parcels processed across ${targets.length - failures.length}/${targets.length} counties.`)

  if (!dryRun) {
    console.log('Finalising shards (gzipping accumulated parts files)...')
    const shardsFinalized = await finalizeShards(outDir, 'scotland')
    console.log(`Finalized ${shardsFinalized} shard file(s).`)
  }

  if (failures.length > 0) {
    console.error(`${failures.length} counties failed:`, failures.map((f) => f.name).join(', '))
    process.exit(1)
  }
}

await main()
