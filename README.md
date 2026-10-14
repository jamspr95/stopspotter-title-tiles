# StopSpotter title boundary tiles

Builds the UK title-boundary lookup tiles that power StopSpotter's
on-demand "Look up title" admin feature. Scrapes HM Land Registry
(England & Wales) and Registers of Scotland open data, parses it, and
publishes gzipped NDJSON shards as GitHub Release assets that
[StopSpotter](https://github.com/jamspr95/stopspotter)'s
`lookup-title-boundary` Supabase Edge Function fetches at query time.

## Why this is a separate repo

Originally part of the `stopspotter` repo. Split out so it can stay
**public** once that app repo goes private:

- GitHub Actions minutes are free and unlimited on a public repo, metered
  on a private one. This pipeline's full `--all` run takes ~2 hours
  (quarterly schedule + occasional manual runs) — keeping it public keeps
  that free regardless of what happens to the app repo.
- Release assets from a **private** repo require authenticated API calls
  (`api.github.com/repos/.../releases/assets/{id}` + a token), not a plain
  `fetch()` — the Edge Function uses a plain unauthenticated fetch, so
  this had to stay public for that to keep working at all.

This code has zero dependency on Supabase, Postgres, or anything else
app-specific — by design, see `docs/TITLE_BOUNDARY_API_PLAN.md`.

## Usage

```bash
npm install

# England & Wales
node scripts/build-title-tiles-ew.mjs --all [--dry-run] [--out=./title-tiles-build]
node scripts/build-title-tiles-ew.mjs --council="Exeter" [--dry-run]

# Scotland
node scripts/build-title-tiles-scotland.mjs --all [--dry-run] [--out=./title-tiles-build]
node scripts/build-title-tiles-scotland.mjs --county="Lanark" [--dry-run]

# Unit tests
npm test
```

`.github/workflows/build-title-tiles.yml` runs both scripts quarterly and
publishes the result as the `title-tiles-latest` GitHub Release, which
`stopspotter`'s edge function reads from directly — see
`docs/TITLE_BOUNDARY_API_PLAN.md` for the full architecture and incident
history.
