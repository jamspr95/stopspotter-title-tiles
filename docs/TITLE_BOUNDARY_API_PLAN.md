# StopSpotter — Title boundary lookup: on-demand plan

> **Moved here from `jamspr95/stopspotter` (Oct 2026)**, split into this
> dedicated public repo so the build pipeline can stay public once the app
> repo goes private — see this repo's README for why. References below to
> `scripts/`, `.github/workflows/build-title-tiles.yml`, and this doc's own
> path are all now relative to *this* repo; references to
> `supabase/functions/`, migrations (`00NN_*.sql`), `src/`, and
> `docs/SETUP.md`/`docs/BUILD_PLAN.md` are still in the `stopspotter` app
> repo, unchanged by the split.

> Replaces the bulk-load design in `0015_title_boundaries.sql`. That design
> (download the entire national INSPIRE/RoS dataset into a Postgres table,
> on a monthly/quarterly schedule) is what filled the original project's
> disk and triggered the outage that led to the `StopSpotter_v1.1` rebuild —
> see the session history for the incident. This plan replaces it with a
> per-nomination, on-demand lookup that never stores national title data in
> Postgres at all.

## Status Key

| Symbol | Meaning |
|---|---|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Complete |

---

## Why the old design failed, in one line

A title lookup only ever needs "is there a registered title at this one
point?" — but the old design answered that by loading *every* title in the
country into a database table, so the storage cost scaled with the size of
Great Britain, not with the number of nominations StopSpotter actually has
(6, at time of writing). This plan makes storage scale with nominations
instead.

## Data source — unchanged, still free

Same two free, open-licensed bulk sources already in use:
- **England & Wales**: HM Land Registry INSPIRE Index Polygons.
- **Scotland**: Registers of Scotland Cadastral Parcels (open data feed).

Confirmed earlier this session: neither registry offers a free, public,
per-point API (HMLR's free `MapSearch` is human-portal-only; Scotland's
ScotLIS API needs a title number as input, not a coordinate, and costs
£3+VAT per lookup on the public side). So the bulk files are still the only
free route to the data — this plan changes *where that data lives and how
it's queried*, not where it comes from.

## Architecture

```
┌─────────────────────┐   ┌──────────────────────────┐   ┌───────────────────────┐
│ Bulk download        │   │ GitHub Release             │   │ Supabase Edge         │
│ (same HMLR/RoS        │──▶│ "title-tiles-latest"      │◀──│ Function              │
│ sources as today)     │   │ <nation>_<cell-id>.json   │   │ lookup-title-boundary  │
│ — build-time only,    │   │ asset per tile (small      │   │ — called per           │
│ run quarterly/manual, │   │ files, free, versioned     │   │   nomination, on       │
│ never touches Postgres│   │ hosting)                   │   │   demand               │
└─────────────────────┘   └──────────────────────────┘   └───────────────────────┘
                                                                     │
                                                                     ▼
                                                     nominations.title_number / .title_tenure
                                                     (one small result per nomination row)
```

**Correction from this plan's first draft**: tiles are published as
**GitHub Release assets**, not GitHub Pages files. Reason found while
implementing: `deploy.yml` already redeploys the *entire* Pages site from
`dist/` on every ordinary app-code push — any tile files sitting in that
same deployment would get wiped out by the very next unrelated push,
since Pages serves one full-replace artifact, not an incremental one.
Releases are independent of that workflow entirely, keep every past
tile-build as its own dated release if ever needed, and don't bloat the
git history the way committing the tiles into the repo would.

Postgres never holds more than one resolved title per nomination. The
national dataset lives as release assets, which cost nothing to store at
any size and nothing to query until a nomination actually needs resolving.

---

## Phase 0 — Build the tile dataset

| Task | Status |
|---|---|
| Shared grid math: `scripts/lib/titleTiles.mjs` — `cellIdForPoint(lat, lng)`, `cellIdsForRings(rings)`, `writeParcelsToShardParts(outDir, nation, parcels)` (append-only per-shard NDJSON), `finalizeShards(outDir, nation)` (one streamed gzip pass per shard, run once after a nation's build). A plain 0.1°×0.1° WGS84 grid (not OS National Grid — the parsed data is already WGS84 by this point in the pipeline, so a second coordinate system would be pure overhead). Unit-tested in `titleTiles.test.mjs` — verified | ✅ |
| `supabase/functions/lookup-title-boundary/index.ts` carries an identical, independently-duplicated copy of the cell-id math (Deno can't import the Node file) — see that file's own comment on why this duplication is deliberate, not drift risk left unmanaged | ✅ |
| Write `scripts/build-title-tiles-ew.mjs` — reuses `sync-title-boundaries-ew.mjs`'s proven download/parse logic (same download-page scraping, same `extractGmlTexts`/`extractParcels` GML parsing) and `titleTiles.mjs`'s `appendParcelsToTiles` instead of `upsertTitleBoundaries`. Plumbing (arg parsing, `appendParcelsToTiles` wiring, tile file output) verified against a synthetic GML fixture — the real HMLR download page/scrape itself could **not** be exercised from this sandbox (network policy blocks it); still needs a real `--dry-run --all` (or a handful of real councils) before trusting a scheduled run | ✅ |
| Write `scripts/build-title-tiles-scotland.mjs` — same approach, reusing `sync-title-boundaries-scotland.mjs`'s `extractParcelsFromBytes` shapefile parsing. Same caveat: plumbing verified against a synthetic fixture only, not the real ros-inspire.themapcloud.com source (also network-blocked from this sandbox) | ✅ |
| `.github/workflows/build-title-tiles.yml` — runs both build scripts, then publishes every generated tile file as an asset on a single, repeatedly-overwritten GitHub Release (`title-tiles-latest`): delete that release if it already exists, then recreate it fresh from this run's output, so there's never a mix of old and new tiles. Quarterly schedule + `workflow_dispatch`, same `--all`/`--council=`/`--dry-run` flag shape as the scripts it replaces. No Postgres credentials needed for this job at all. Written and YAML-validated, but never run — a real GitHub Actions execution (including the actual `gh release create` call) is still unverified | ✅ |
| **Asset-count risk — fixed**: a fine-cell-per-file layout would have produced ~3,000 files for all of Great Britain, well over GitHub Releases' 1,000-asset cap. Fixed by splitting the grid into two sizes: the fine 0.1° lookup grid stays as the correctness/indexing unit, but a `FINE_CELLS_PER_SHARD` (5) × 5 block of fine cells is grouped into one gzipped shard file, bringing a full-GB build down to roughly **128 files** — comfortably under the cap with real headroom. Coordinates are also rounded to 6 decimal places (~11cm) on write, trimming the double-precision BNG→WGS84 output that was otherwise pure wasted bytes. The workflow's own asset-count check (at the `.json.gz` extension) is kept as a defensive floor, not removed. | ✅ |
| **Real incident (Oct 2026): OOM crash on the first live `--all` run — fixed**. The shard design above kept file *count* low but the first implementation's merge strategy (`appendParcelsToTiles`) fully read back, gunzipped, and `JSON.parse`'d a shard's *entire* existing content on every council that touched it. Against live HMLR data this crashed the real run (job id `38597772116`) after ~1h53m, having processed nearly all 318 England & Wales councils: several dense-area councils (Stevenage, Tandridge, The North Yorkshire Council, Three Rivers, Waverley) hit `Invalid string length` as their shared shard grew past V8's string limit, then the run finally died with a fatal `JavaScript heap out of memory` inside `JSON.parse` — confirmed from the actual job log, not guessed. **Fix**: rewrote `scripts/lib/titleTiles.mjs` to eliminate all read-back. `writeParcelsToShardParts()` now only *appends* small newline-delimited JSON lines to a per-shard `_parts/<shardId>.ndjson` file during the main per-council loop (cheap, bounded by one council's own data); `finalizeShards()` runs once after a nation's full loop and streams each shard's parts file through gzip (`createReadStream → createGzip → createWriteStream`) straight to the final `<shardId>.json.gz`, so no shard's content is ever held as one in-memory string or object, however large. The build scripts, `lookup-title-boundary/index.ts` (now parses NDJSON lines instead of a `{cells:{...}}` object, filtering by each line's own fine-cell id as it streams), and `titleTiles.test.mjs` were all updated to match; the old within-run title-number dedup (a side effect of the old read-back) was dropped as unneeded — each title number comes from exactly one council's source file, so the only repetition within a run is a parcel deliberately written under several fine cells it overlaps, never a true duplicate within one cell. Re-verified with `node --check`, the unit tests, and `npm run build`. | ✅ |
| **Confirmed fixed (Oct 2026, first real run in this repo, job id `38632057756`)**: no OOM, no heap crash — processed all 318 England & Wales councils (23.3M parcels) and finalized 114 gzipped shards cleanly. Two smaller problems surfaced instead, both now fixed: (1) the workflow treated ANY per-council failure as fatal to the whole job, skipping Scotland entirely and never publishing a release even though 97%+ of England & Wales had parsed correctly — fixed by making the two build steps `continue-on-error: true` so Flatten/Check/Publish always run after them, with a trailing step that still fails the job (red, visible) if either nation had errors, so a partial success ships instead of nothing; (2) most of the 8 failed councils (Thurrock, Wrexham, and others) failed with a bare `fetch failed` — the signature of a one-off network blip — fixed with a 3-attempt retry (`scripts/lib/retry.mjs`) around each council/county's download. | ✅ |
| **First successful real publish (Oct 2026, job id `38675656306`)**: with both fixes above in place, the full `--all` run against live HMLR/RoS data completed and published `title-tiles-latest` — 217 shard assets, 316/318 England & Wales councils (23.7M parcels) and 32/33 Scottish counties (1.5M parcels). The job still finished "red" by design (see the trailing step above) because 3 areas failed: **Cornwall Council**, **The North Yorkshire Council**, and **Dumfries** all hit the same V8 hard per-string-length ceiling (`Cannot create a string longer than 0x1fffffe8 characters` / `Invalid string length`) decoding their GML text as one JS string — all three are large, mostly-rural areas with unusually large combined parcel datasets, not a parsing-logic bug. Title lookups are live and returning real matches for the rest of Great Britain. | ✅ |
| **Streaming parser for the 3 outlier-sized areas**: `inspireGml.mjs` gained `extractGmlBuffers` (byte-level, never stringifies the whole document) and `extractParcelsFromLargeBuffer` (reads the raw bytes in bounded ~32MB windows, reassembling and parsing each parcel feature individually the moment both its open and close tag have appeared — reusing `extractParcels` completely unchanged per feature, so the already-proven parsing logic itself didn't change, only how the raw bytes get split into feature-sized pieces first). Both build scripts and `parcelExtraction.mjs`'s Scotland GML branch now catch the specific string-length `RangeError` and fall back to this automatically — every other error (a real schema mismatch, a corrupt download) still surfaces unchanged. Verified with a synthetic fixture forced through chunk boundaries as small as 97 bytes (smaller than any one real feature), confirming byte-for-byte identical output to the whole-string parser including a feature split mid-tag and mid-UTF-8-character, plus a safety-valve test for a genuinely malformed/truncated file (`inspireGml.test.mjs`). **Not yet confirmed against the real Cornwall/North Yorkshire/Dumfries files** — this sandbox can't download multi-hundred-MB files from HMLR/RoS to test against directly, so a live `--council=`/`--county=`-scoped run against exactly these 3 areas is the next step before calling this done. | 🔄 implemented + unit-tested, pending a live scoped run |

## Phase 1 — The lookup Edge Function

| Task | Status |
|---|---|
| `supabase/functions/lookup-title-boundary/index.ts` — takes `{lat, lng}`, computes the cell id, fetches that cell's two possible tile assets (`england_wales_<id>.json`, `scotland_<id>.json`) from the `title-tiles-latest` release, does a plain point-in-polygon test in memory (hand-rolled ray-casting, no new dependency), and returns `{titleNumber, tenure}`. Checks `current_user_is_admin()` itself (forwarding the caller's own JWT), same authorization pattern as every admin RPC | ✅ |
| Deployed to `StopSpotter_v1.1` via `mcp__Supabase__deploy_edge_function` | ✅ |

## Phase 2 — Wire it into the app

| Task | Status |
|---|---|
| Migration `0017_title_lookup_columns.sql`: `nominations.title_number`, `.title_tenure`, `.title_checked_at` — one resolved result per nomination | ✅ |
| Admin-only RPC `admin_set_nomination_title(p_nomination_id, p_title_number, p_title_tenure)` | ✅ |
| `AdminStopDetailScreen`'s `LookupTitleButton` — a manual "Look up title" action (`src/components/TitleBoundary.tsx`), calling `db.lookupNominationTitle()` → the Edge Function → the RPC above, via a new `useAdminStore.lookupNominationTitle` action | ✅ |
| `admin_list_nominations()` — drops the `LEFT JOIN LATERAL ... title_boundaries`, selects `title_number`/`title_tenure`/`title_checked_at` straight off the row | ✅ |
| `src/lib/priority.ts`'s `NO_KNOWN_OWNER_BOOST` — fixed to require `titleCheckedAt != null` as well as `titleNumber == null`; the on-demand design means most nominations start unchecked, so the old "titleNumber null = no known owner" proxy would have wrongly boosted every not-yet-looked-up nomination | ✅ |

## Phase 3 — Retire the old bulk system

| Task | Status |
|---|---|
| `public.title_boundaries` and `admin_title_boundary_coverage()` — `DROP TABLE`/`DROP FUNCTION` both timed out against this project (same "DROP times out here" characteristic this repo has hit before — 0009/0011/0014/0015; confirmed via `pg_stat_activity` showing nothing actually blocked). Same proven workaround used: renamed to `_retired` and `EXECUTE` revoked, left as inert dead schema rather than forcing a retry loop | ✅ |
| Delete `scripts/sync-title-boundaries-ew.mjs` / `-scotland.mjs` and `.github/workflows/sync-title-boundaries-{ew,scotland}.yml`, once Phase 0's replacements are confirmed working end to end | ⬜ |
| Update `docs/SETUP.md`'s title boundary section to describe this design instead of the bulk-load one | ⬜ |
| Add a line to `docs/PROJECT_PLAN.md`'s decisions log recording *why* this changed (the disk-exhaustion incident, dated, with a link back to this file) | ⬜ |

---

## What this deliberately does not do

- **No automation of England/Wales or Scotland's own search portals** — both are consumer web UIs, not APIs; nothing here scrapes or automates them. The free MapSearch / paid ScotLIS portals remain fine fallbacks for a human doing a one-off manual check outside this system.
- **No new paid service** — everything here (GitHub Pages hosting, a Supabase Edge Function call) is already inside the stack and free at StopSpotter's current and foreseeable scale.
- **No attempt to recover the partial data already loaded into the old `title_boundaries` table** — that table only ever covered 24 of 351 areas before the outage, with no record of which, so it wasn't safe to trust anyway (see the coverage-tracking gap noted in `0016_title_boundary_coverage.sql`'s own limits). Starting clean with the tile-based design is simpler than trying to salvage it.
