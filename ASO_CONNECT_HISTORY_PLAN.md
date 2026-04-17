# ASO Connect — Local History & Change Tracking Implementation Plan

**Goal:** Add local SQLite-backed history to ASO Connect so that keyword scoring, metadata changes, and active keyword state are persisted across `/aso-optimize` runs. This enables decision stability (no needless re-churn of keywords), attribution (did my last change help?), and trend awareness.

**Scope:** Single-user local deployment. Each user generates their own DB. No multi-tenant concerns, no migration framework.

**Tech:** Node.js, `better-sqlite3`, WAL mode, file at `./.aso-connect/aso.db` (gitignored).

---

## Phase 1 — Foundation (DB, init, meta)

### Task 1.1 — Install dependency
- Add `better-sqlite3` to `package.json` dependencies
- Run `npm install better-sqlite3`
- Verify it builds on current Node version (native module)

### Task 1.2 — Create DB module
Create `lib/db.js` that exports a singleton DB connection.

Requirements:
- DB path: `path.join(projectRoot, '.aso-connect', 'aso.db')`
- Create parent dir with `fs.mkdirSync(..., { recursive: true })` before opening
- Set pragmas on open:
  - `journal_mode = WAL`
  - `synchronous = NORMAL`
  - `foreign_keys = ON`
- Export: `getDb()` function returning the Database instance
- Handle graceful close on `process.exit` / SIGINT

### Task 1.3 — Schema initialization
Create `lib/schema.js` with an `initSchema(db)` function that runs idempotent `CREATE TABLE IF NOT EXISTS` for all tables.

Tables to create in Phase 1:

```sql
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  bundle_id TEXT PRIMARY KEY,
  name TEXT,
  primary_category_id INTEGER,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_at INTEGER NOT NULL,
  source TEXT,
  FOREIGN KEY (bundle_id) REFERENCES apps(bundle_id)
);
CREATE INDEX IF NOT EXISTS idx_changes_app_locale 
  ON metadata_changes(bundle_id, locale, changed_at DESC);

CREATE TABLE IF NOT EXISTS active_keywords (
  bundle_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  keyword TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_score_popularity REAL,
  last_score_difficulty REAL,
  last_score_opportunity REAL,
  last_scored_at INTEGER,
  PRIMARY KEY (bundle_id, locale, keyword),
  FOREIGN KEY (bundle_id) REFERENCES apps(bundle_id)
);
```

Constraints on `field` column values (enforce in app code, not DB): `name | subtitle | keywords | promotional_text | description | whats_new`.
Constraints on `source` column (enforce in app code): `aso-optimize | manual | rollback | import`.

### Task 1.4 — Schema version guard
After `initSchema`:
- Read `schema_version` from `_meta`. If missing, set to current `EXPECTED_SCHEMA_VERSION = 1`.
- If present but lower than expected, log clear error and exit:
  ```
  ASO Connect: DB schema outdated (found v{X}, expected v{Y}).
  Delete .aso-connect/aso.db to reinitialize. History will be lost.
  ```
- Don't auto-migrate.

### Task 1.5 — Gitignore
Add to `.gitignore`:
```
.aso-connect/
```

### Task 1.6 — Wire init into MCP server startup
In `mcp-server.js`:
- Import `getDb` and `initSchema`
- Call `initSchema(getDb())` once at startup, before tools are registered
- Any init error should crash loudly with actionable message

**Done when:** Starting the MCP server creates `.aso-connect/aso.db` with all Phase 1 tables. Running it a second time is a no-op.

---

## Phase 2 — Repository layer

Create `lib/repos/` directory with one file per table. Each repo exports plain functions taking `db` as first arg (or uses the singleton). No ORM, just prepared statements.

### Task 2.1 — `lib/repos/apps.js`
Functions:
- `upsertApp(bundleId, { name, primaryCategoryId })` — INSERT OR REPLACE, set `added_at` only on insert (use `ON CONFLICT DO UPDATE SET name = excluded.name, primary_category_id = excluded.primary_category_id`)
- `getApp(bundleId)` — returns row or null
- `listApps()` — returns array

### Task 2.2 — `lib/repos/metadataChanges.js`
Functions:
- `logChange({ bundleId, locale, field, oldValue, newValue, source })` — appends with `changed_at = Date.now()`
- `getChangesFor(bundleId, locale, { field?, sinceMs?, limit? })` — filtered query, ordered `changed_at DESC`
- `getLastChange(bundleId, locale, field)` — single most recent

Note: For `keywords` field, store the full comma-separated string in `old_value` / `new_value`. Diffing individual keywords is a consumer concern.

### Task 2.3 — `lib/repos/activeKeywords.js`
Functions:
- `setActiveKeywords(bundleId, locale, keywords[])` — transactional:
  1. Load current active keywords for (bundleId, locale)
  2. Delete rows for keywords no longer present
  3. Insert new keywords with `added_at = Date.now()`
  4. Leave unchanged keywords alone (preserve their `added_at`)
- `getActiveKeywords(bundleId, locale)` — returns array with all columns
- `updateKeywordScore(bundleId, locale, keyword, { popularity, difficulty, opportunity })` — sets last_score_* fields and `last_scored_at = Date.now()`
- `getKeywordAge(bundleId, locale, keyword)` — returns days since `added_at` or null if not found

### Task 2.4 — Repo tests (lightweight)
Create `test/repos.test.js` using Node's built-in `node:test` runner. No Jest dependency needed.
- Each test creates in-memory DB (`new Database(':memory:')`)
- Runs `initSchema` on it
- Tests one repo function per test case
- Cover: insert, update (no duplicate), query with filters, transaction rollback on error

Target: every repo function has at least one happy-path test and one edge case.

**Done when:** `npm test` passes. Repos can be consumed by tool handlers.

---

## Phase 3 — Integrate into existing tools

Modify existing tools in place. No new MCP tools yet.

### Task 3.1 — `asc_update_version_localization` wrapper
Before calling ASC API to update metadata:
- Fetch current values via `asc_get_version_localizations` (or from passed context)
- After successful update, for each changed field, call `logChange()` with `source: 'aso-optimize'` (or pass source as parameter, default to `'manual'`)

Same treatment for `asc_update_app_info_localization`.

### Task 3.2 — `asc_lookup_app` side effect
When a bundle_id is successfully looked up, call `upsertApp()` to ensure it's in the `apps` table. This guarantees FK integrity for subsequent `metadata_changes` inserts.

### Task 3.3 — Keyword score caching in `score_keyword` / `score_keywords_batch`
After computing scores, if the keyword is in `active_keywords` for any app, call `updateKeywordScore()` to record the latest score and `last_scored_at`.

This is a "free" data capture — no extra API calls, just persist what we already computed.

### Task 3.4 — `/aso-optimize` skill flow update
Modify the skill to:
1. After fetching current metadata from ASC, call `setActiveKeywords(bundleId, locale, parsedKeywords)` to sync DB state with reality
2. When deciding whether to propose replacing a keyword, check `getKeywordAge()`:
   - If age < 30 days AND current score hasn't dropped by ≥ 20 points since `last_scored_at`, skip replacement (hysteresis rule)
   - Otherwise proceed
3. When pushing changes, pass `source: 'aso-optimize'` through to the update wrappers so `metadata_changes` is properly attributed

**Done when:** Running `/aso-optimize` twice in a row on the same app produces zero churn on the second run (because nothing aged or changed enough to justify replacement).

---

## Phase 4 — New read-only MCP tools

Expose DB via new tools so Claude can answer questions without needing schema knowledge.

### Task 4.1 — `aso_db_stats`
No inputs. Returns JSON:
```json
{
  "db_path": "...",
  "db_size_bytes": 12345,
  "schema_version": 1,
  "counts": {
    "apps": 5,
    "metadata_changes": 87,
    "active_keywords": 112
  },
  "earliest_change_at": 1730000000000,
  "latest_change_at": 1760000000000,
  "apps": [
    { "bundle_id": "com.example.app1", "name": "App One", "tracked_since": 1730000000000 }
  ]
}
```

### Task 4.2 — `aso_get_change_history`
Inputs: `bundle_id` (required), `locale` (optional), `field` (optional), `since_days` (optional, default 90), `limit` (optional, default 50).
Returns ordered list of changes. Useful for Claude to answer "what did I change recently?"

### Task 4.3 — `aso_get_active_keywords_with_age`
Inputs: `bundle_id`, `locale`.
Returns active keywords with `days_since_added`, `days_since_scored`, and last scores. This is the tool `/aso-optimize` hysteresis check should use internally — also exposed for Claude introspection.

### Task 4.4 — `aso_get_keyword_score_history`
Inputs: `bundle_id`, `locale`, `keyword`.
Returns a single row (current state from `active_keywords`) for Phase 4. Time-series comes in Phase 5.

**Done when:** Claude can answer "when did I last change the subtitle for com.example.app1 in de-DE?" and "which of my active keywords are older than 60 days and losing opportunity score?" without running raw SQL.

---

## Phase 5 — Optional: Keyword snapshots (time-series)

Skip if not needed yet. Add when doing cron-based daily tracking or rank monitoring.

### Task 5.1 — Add snapshot table
```sql
CREATE TABLE IF NOT EXISTS keyword_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  locale TEXT NOT NULL,
  popularity REAL,
  difficulty REAL,
  opportunity REAL,
  raw_json TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_keyword 
  ON keyword_snapshots(keyword, locale, fetched_at DESC);
```

Bump `EXPECTED_SCHEMA_VERSION` to 2. Users with v1 DBs will see the "delete and reinitialize" message.

### Task 5.2 — Snapshot repo
`lib/repos/keywordSnapshots.js`:
- `appendSnapshot({ keyword, locale, popularity, difficulty, opportunity, rawJson })`
- `getHistory(keyword, locale, { sinceMs?, limit? })`

### Task 5.3 — New tool `aso_snapshot_keywords`
Inputs: `keywords[]`, `locales[]`.
Calls existing `score_keywords_batch` and persists each result with `appendSnapshot()`.

### Task 5.4 — New tool `aso_keyword_trend`
Inputs: `keyword`, `locale`, `days` (default 30).
Returns time series of scores. Claude can interpret trends without a charting library.

---

## Phase 6 — Rank tracking (keyword position in SERP)

Track where your app ranks in iTunes Search API results for each keyword you care about. This closes the attribution loop: you can now correlate metadata changes with actual position movements.

**Important caveat on data source:**
iTunes Search API returns a ranked list of apps for a given keyword + country, but this is NOT identical to what a user sees in the App Store app (Apple applies personalization, device-type weighting, and other signals). iTunes Search API rankings are a **proxy** — reliable for detecting *movement* (trend signal) but not ground truth for absolute position. For ground truth, paid providers (AppFigures, AppTweak, Sensor Tower) scrape real App Store results. This plan uses iTunes Search API only; ground-truth integration would be a separate plan.

iTunes Search API returns up to 200 results per query. If your app isn't in top 200 for a keyword, rank is recorded as `null` (not-ranked).

### Task 6.1 — Add rank tracking tables

Bump `EXPECTED_SCHEMA_VERSION` to 2 (or 3 if Phase 5 was done first — phases 5 and 6 can ship independently, so coordinate version bumps).

```sql
CREATE TABLE IF NOT EXISTS keyword_ranks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  locale TEXT NOT NULL,
  rank INTEGER,                    -- 1-200, or NULL if not in top 200
  total_results INTEGER,           -- how many apps iTunes returned for this query
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'itunes_search',
  FOREIGN KEY (bundle_id) REFERENCES apps(bundle_id)
);
CREATE INDEX IF NOT EXISTS idx_ranks_app_keyword 
  ON keyword_ranks(bundle_id, keyword, locale, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_ranks_fetched 
  ON keyword_ranks(fetched_at DESC);

CREATE TABLE IF NOT EXISTS tracked_keywords (
  bundle_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  locale TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_tracked_at INTEGER,
  PRIMARY KEY (bundle_id, keyword, locale),
  FOREIGN KEY (bundle_id) REFERENCES apps(bundle_id)
);
```

Two tables because they serve different purposes:
- `tracked_keywords` = configuration ("track these keywords for this app"). Mutable, small.
- `keyword_ranks` = time-series observations. Append-only, grows.

A tracked keyword doesn't need to currently be in your metadata — you might want to watch keywords you're considering, or track competitors' keywords as market signal.

### Task 6.2 — Rank repo

Create `lib/repos/ranks.js`:

- `addTrackedKeyword(bundleId, keyword, locale)` — INSERT OR IGNORE, returns boolean indicating whether it was newly added
- `removeTrackedKeyword(bundleId, keyword, locale)`
- `listTrackedKeywords(bundleId, locale?)` — returns array, optionally filtered by locale
- `recordRank({ bundleId, keyword, locale, rank, totalResults })` — appends to `keyword_ranks`, also updates `tracked_keywords.last_tracked_at`
- `getRankHistory(bundleId, keyword, locale, { sinceMs?, limit? })` — time series
- `getLatestRank(bundleId, keyword, locale)` — most recent row or null
- `getRankMovements(bundleId, locale, { sinceDays = 14 })` — for each tracked keyword, compares earliest vs latest rank in the window, returns those with meaningful movement (defined below)

Repo tests in `test/repos.test.js` following the same pattern as Phase 2.

### Task 6.3 — Rank fetching logic

Create `lib/rankFetcher.js` with `fetchRank(bundleId, keyword, locale)`:

1. Call iTunes Search API: `https://itunes.apple.com/search?term={keyword}&country={cc}&media=software&limit=200`
2. Map response to array of bundle IDs in order
3. Find index of `bundleId` in that array
4. Return `{ rank: index + 1, totalResults: response.length }` or `{ rank: null, totalResults: response.length }` if not found

Respect the existing 1 req/sec rate limit in ASO Connect. Batch operations should serialize through the same limiter used by `score_keywords_batch`.

### Task 6.4 — New MCP tools

**`aso_track_keyword`** — add a keyword to tracking
- Inputs: `bundle_id`, `keyword`, `locale`
- Side effect: inserts into `tracked_keywords`, immediately fetches initial rank
- Returns: `{ added: true, initial_rank: 42 }` or `{ added: false, reason: 'already_tracked' }`

**`aso_track_active_keywords`** — bulk helper
- Inputs: `bundle_id`, `locale`
- Reads `active_keywords` for that app+locale, adds each one to `tracked_keywords`
- Useful one-liner after running `/aso-optimize`: "also track everything I'm currently using"

**`aso_untrack_keyword`** — remove from tracking
- Inputs: `bundle_id`, `keyword`, `locale`
- Does NOT delete historical rank data, only stops future tracking

**`aso_refresh_ranks`** — fetch current ranks for tracked keywords
- Inputs: `bundle_id` (optional — all apps if omitted), `locale` (optional), `stale_hours` (optional, default 20 — only refresh keywords not tracked in the last N hours)
- For each tracked keyword matching filters, calls `fetchRank` and `recordRank`
- Returns summary: `{ refreshed: 15, skipped_fresh: 8, errors: 1 }`
- This is the workhorse tool, designed to be called from cron or manually

**`aso_get_rank_history`** — time series for a single keyword
- Inputs: `bundle_id`, `keyword`, `locale`, `days` (default 30)
- Returns array of `{ fetched_at, rank, total_results }`

**`aso_get_rank_movements`** — movement detection, the headline tool
- Inputs: `bundle_id`, `locale` (optional), `since_days` (default 14), `min_movement` (default 5)
- Returns keywords where rank moved by at least `min_movement` positions, classified as:
  - `entered_top_10` — was > 10 or null, now ≤ 10
  - `dropped_from_top_10` — was ≤ 10, now > 10 or null
  - `entered_top_100` — was > 100 or null, now ≤ 100
  - `dropped_out_of_ranking` — was ranked, now null
  - `newly_ranked` — was null, now ranked
  - `climbing` — rank improved by ≥ `min_movement` (non-null → non-null)
  - `falling` — rank degraded by ≥ `min_movement` (non-null → non-null)
- Each result includes: `keyword`, `locale`, `old_rank`, `new_rank`, `delta`, `classification`, `time_window_days`

This is the tool that makes rank tracking actionable. Without classification, Claude has to interpret raw numbers every time.

### Task 6.5 — Movement detection rules (to prevent noise)

iTunes Search API has natural volatility — ranks can wobble ±2-3 positions between calls without anything real happening. Encode anti-noise rules in `getRankMovements`:

- **Minimum delta**: default 5 positions, configurable via `min_movement`
- **Minimum sample**: need at least 2 data points in window; skip keywords with only 1
- **Percentage for deep ranks**: for rank > 50, require movement of at least 10% of the old rank (so rank 80 → 85 is noise, rank 80 → 68 is movement). For rank ≤ 50, absolute 5-position threshold applies.
- **Null transitions always count**: going from ranked to not-ranked (or vice versa) is always reported regardless of thresholds — it's a categorical change.

### Task 6.6 — Integration with `/aso-optimize`

Enhance the skill to use rank data in decisions:

1. After fetching current metadata, call `aso_track_active_keywords` so all current keywords are automatically tracked going forward (idempotent).
2. Before proposing replacements, fetch `aso_get_rank_movements` for the last 30 days:
   - If a keyword is `climbing`, DO NOT replace it even if score suggests alternatives exist. It's working.
   - If a keyword is `falling` AND `last_change_at` for metadata was > 14 days ago (so the fall can't be attributed to a recent change), flag it strongly for replacement.
   - If a keyword is `dropped_out_of_ranking` and you're actively using it, flag for urgent review.
3. After pushing changes, record the timestamp so the next run can correlate future rank movements with the deployment.

Update the hysteresis rule from Phase 3 to consider rank trend:
- Original: skip replacement if age < 30 days AND score didn't drop ≥ 20 points
- Enhanced: skip replacement if age < 30 days AND score didn't drop ≥ 20 points AND rank is not `falling` or worse

Rank signal OVERRIDES age protection — if a keyword is clearly dying in rank, you want to replace it regardless of how recently it was added.

### Task 6.7 — Optional: scheduled refresh helper

Document (in README, not code) how users can set up a cron or launchd job to call `aso_refresh_ranks` daily. Example:

```bash
# Add to crontab for daily 9am refresh
0 9 * * * cd /path/to/aso-connect && node scripts/refresh-ranks.js
```

Provide `scripts/refresh-ranks.js` as a standalone Node script that opens the DB and calls the same logic as the MCP tool, so users don't need Claude Code running for scheduled refreshes.

### Checkpoint 6 — Done when:

- Can add a keyword to tracking via `aso_track_keyword`, verify initial rank is recorded
- `aso_refresh_ranks` skips keywords tracked within `stale_hours` (idempotent, cheap to over-call)
- After 2+ data points exist, `aso_get_rank_movements` correctly classifies movements and filters noise per Task 6.5 rules
- `/aso-optimize` uses rank trend to skip replacement of climbing keywords and accelerate replacement of falling ones
- Running `aso_get_rank_history` for a keyword returns a chronological series that Claude can summarize

---

## Phase 7 — Category chart position (RSS feeds)

Track where your app ranks in App Store top charts per category, country, and chart type. This is an independent signal from keyword search rank: it tells you how Apple's organic discovery (Top Charts, category browse, Apple-curated lists) is ranking you.

**Data source:** Apple's public RSS marketing feeds. Free, no auth, no rate limit that matters.

```
https://rss.applemarketingtools.com/api/v2/{country}/apps/{chart}/{limit}/apps.json
```

Where:
- `country` — two-letter country code (us, pl, de, fr, gb, …)
- `chart` — `top-free`, `top-paid`, or `top-grossing`
- `limit` — up to 100

**Important caveat on genre filtering:**
The RSS feed above is the *overall* chart for a country (all apps combined). To get category-specific charts (e.g., "Top Free Games in Poland"), you need the legacy iTunes RSS endpoint:

```
https://itunes.apple.com/{country}/rss/{chart}/limit=200/genre={genre_id}/json
```

Legacy endpoint still works but is less officially documented. Genre IDs are static (Games = 6014, Productivity = 6007, Utilities = 6002, etc.) — bundle the full list as a constant in code.

Chart position fetched this way is **ground truth from Apple**, not a proxy. Unlike iTunes Search API keyword rank, RSS charts are what users actually see when they browse. That makes category rank a stronger signal than keyword rank.

### Task 7.1 — Add category rank tables

Bump `EXPECTED_SCHEMA_VERSION` again (coordinate with Phases 5 and 6).

```sql
CREATE TABLE IF NOT EXISTS category_ranks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id TEXT NOT NULL,
  country TEXT NOT NULL,              -- 'us', 'pl', etc. (not locale — charts are per-country)
  genre_id INTEGER,                   -- NULL = overall chart, not genre-specific
  chart_type TEXT NOT NULL,           -- 'top-free' | 'top-paid' | 'top-grossing'
  rank INTEGER,                       -- 1-200 or NULL if not in top 200
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (bundle_id) REFERENCES apps(bundle_id)
);
CREATE INDEX IF NOT EXISTS idx_cat_ranks_app 
  ON category_ranks(bundle_id, country, genre_id, chart_type, fetched_at DESC);

CREATE TABLE IF NOT EXISTS tracked_charts (
  bundle_id TEXT NOT NULL,
  country TEXT NOT NULL,
  genre_id INTEGER,                   -- NULL = overall chart
  chart_type TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_tracked_at INTEGER,
  PRIMARY KEY (bundle_id, country, genre_id, chart_type),
  FOREIGN KEY (bundle_id) REFERENCES apps(bundle_id)
);
```

Note `country` not `locale` — chart is country-level, language doesn't apply. `de-DE` and `de-AT` are different charts (Germany vs Austria) even if language is the same.

Also add a static constants file `lib/genres.js` mapping genre IDs to human-readable names, so tools can return friendly labels.

### Task 7.2 — Category rank repo

Create `lib/repos/categoryRanks.js`:

- `addTrackedChart(bundleId, country, genreId, chartType)` — INSERT OR IGNORE
- `removeTrackedChart(bundleId, country, genreId, chartType)`
- `listTrackedCharts(bundleId?)` — returns array, optionally filtered by app
- `recordCategoryRank({ bundleId, country, genreId, chartType, rank })` — appends to `category_ranks`, updates `tracked_charts.last_tracked_at`
- `getCategoryRankHistory(bundleId, country, genreId, chartType, { sinceMs?, limit? })`
- `getLatestCategoryRank(bundleId, country, genreId, chartType)` — most recent row
- `getCategoryMovements(bundleId?, { sinceDays = 14, minMovement = 3 })` — returns classified movements (same pattern as `getRankMovements`)

Why `minMovement = 3` default (vs 5 for keyword rank): category charts are more stable than keyword SERPs. A 3-position move in top 100 Games is meaningful; in keyword SERP a 3-position move is often noise.

### Task 7.3 — Category fetcher

Create `lib/categoryFetcher.js` with two functions:

```js
fetchOverallChart(country, chartType, limit = 100)
// calls rss.applemarketingtools.com, returns [{ bundleId, rank }]

fetchGenreChart(country, genreId, chartType, limit = 200)
// calls itunes.apple.com/{country}/rss/...
// returns [{ bundleId, rank }]
```

Both handle network errors gracefully and normalize response shape.

Wrap both in `fetchCategoryRank(bundleId, country, genreId, chartType)` that:
1. Fetches the appropriate chart (overall or genre-specific)
2. Finds bundleId's position (or null if not in top 100/200)
3. Returns `{ rank: number | null, totalResults: number }`

### Task 7.4 — New MCP tools

**`aso_track_chart`** — start tracking app position in a chart
- Inputs: `bundle_id`, `country`, `genre_id` (optional — null for overall), `chart_type` (default `'top-free'`)
- Side effect: inserts into `tracked_charts`, immediately fetches initial rank
- Returns: `{ added: true, initial_rank: 47, chart: 'Games top-free PL' }`

**`aso_track_app_categories`** — bulk helper
- Inputs: `bundle_id`, `countries[]`
- For each country, looks up the app's primary and secondary genres from ASC, then adds tracking for:
  - Overall `top-free` chart
  - Primary genre `top-free` chart
  - Secondary genre `top-free` chart (if exists)
  - Same for `top-grossing` if the app has IAP/subscriptions
- Returns list of charts added

**`aso_refresh_category_ranks`** — fetch current chart positions
- Inputs: `bundle_id` (optional), `stale_hours` (default 20)
- For each tracked chart matching filters, fetches current rank and records
- Returns summary: `{ refreshed, skipped_fresh, errors }`

**`aso_get_category_rank_history`** — time series
- Inputs: `bundle_id`, `country`, `genre_id` (optional), `chart_type`, `days` (default 30)
- Returns chronological series

**`aso_get_category_movements`** — classified movements, headline tool
- Inputs: `bundle_id` (optional), `since_days` (default 14)
- Returns movements using classification similar to keyword ranks:
  - `entered_top_10` / `dropped_from_top_10`
  - `entered_top_50` / `dropped_from_top_50`
  - `entered_top_100` / `dropped_from_top_100`
  - `dropped_out_of_chart` — was ranked, now null
  - `newly_charted` — was null, now ranked
  - `climbing` / `falling` — numeric moves

**`aso_category_snapshot`** — one-shot read of current position across all tracked charts for an app
- Inputs: `bundle_id`
- Returns table-like structure showing where the app sits right now in every tracked chart
- Useful for quick "how am I doing" overview without parsing time-series

### Task 7.5 — Integration with `/aso-optimize`

Category rank movements become a decision input:

1. Before keyword analysis, call `aso_get_category_movements` for the app being optimized.
2. If the app is `climbing` in its primary category, the ASO optimizer should be *conservative* — something is working, don't disrupt metadata more than necessary.
3. If the app is `falling` across multiple charts simultaneously, this is a stronger signal than any single keyword movement — recommend broader review (not just keyword swaps: subtitle, screenshots, promotional text, pricing).
4. `dropped_from_top_10` in category should be flagged as urgent, because top 10 placement drives significant organic install volume — losing it usually correlates with lost featuring or ratings drop, both of which may require non-metadata fixes.

Enhance the skill's final report to always include a "Category snapshot" section with current position + trend across tracked charts, even if the current task is keyword optimization. It gives Daniel the full situational picture in one run.

### Task 7.6 — Standalone refresh script

Extend `scripts/refresh-ranks.js` (from Task 6.7) to also refresh category ranks, OR create a parallel `scripts/refresh-charts.js`.

Prefer one combined script: `scripts/refresh-all.js` that calls both `aso_refresh_ranks` and `aso_refresh_category_ranks` in sequence. Simpler cron setup:

```bash
0 9 * * * cd /path/to/aso-connect && node scripts/refresh-all.js
```

### Checkpoint 7 — Done when:

- Can track overall + genre charts for an app across multiple countries via `aso_track_app_categories`
- `aso_refresh_category_ranks` fetches from both RSS endpoints (overall and legacy iTunes genre RSS) without errors
- `aso_category_snapshot` returns a clean current-position overview for all tracked charts
- `aso_get_category_movements` correctly classifies chart movements with stricter thresholds than keyword movements (default min 3 positions)
- `/aso-optimize` includes category trend in its decision context and final report

---

## Implementation order & checkpoints

Work strictly in phase order. After each phase, verify the checkpoint before starting the next.

**Checkpoint 1** (after Phase 1): `node mcp-server.js` creates the DB, subsequent runs are idempotent, `.aso-connect/` is gitignored.

**Checkpoint 2** (after Phase 2): `npm test` passes with repo tests. Can manually `require` a repo in a REPL and perform CRUD.

**Checkpoint 3** (after Phase 3): Running `/aso-optimize` twice on the same app shows zero changes on the second run. `metadata_changes` table has entries after a real ASC update.

**Checkpoint 4** (after Phase 4): Claude, given only the new MCP tools (no schema knowledge), can answer introspective questions about tracked apps.

**Checkpoint 5** (Phase 5, optional): Can populate `keyword_snapshots` via cron and query trends.

**Checkpoint 6** (Phase 6): Rank tracking active for at least one app, `aso_get_rank_movements` returns classified movements after a few days of data, `/aso-optimize` decisions are informed by rank trends.

**Checkpoint 7** (Phase 7): Category chart positions tracked via RSS feeds for tracked apps, `aso_category_snapshot` shows current-position overview, category movements feed into `/aso-optimize` decisions.

---

## Notes & gotchas

- `better-sqlite3` is synchronous. Don't wrap calls in `async`. MCP tool handlers can call directly.
- Store all timestamps as `Date.now()` (Unix ms integer). Never ISO strings. Convert to human-readable only at display time.
- `FOREIGN KEY` requires the pragma to be set *every* connection. The `getDb()` singleton handles this — don't open ad-hoc connections.
- Transactions via `db.transaction(fn)(...)` — use for any multi-statement write (especially `setActiveKeywords`).
- `INSERT OR REPLACE` wipes and reinserts, which breaks auto-increment IDs and triggers ON DELETE FKs. Prefer `ON CONFLICT DO UPDATE` for upserts.
- Keep `raw_json` as TEXT, not BLOB. Easier to inspect with `sqlite3 aso.db` CLI when debugging.
- When a user deletes `.aso-connect/aso.db`, the next MCP startup should recreate it silently. No warnings about lost history — the user did it intentionally.

---

## Out of scope (explicitly)

These are NOT part of this plan. Do not implement unless separately requested:
- ASC Analytics API integration (historical impressions, conversion rate, source breakdown, official chart position history — requires async report-generation workflow, different from sync endpoints used elsewhere)
- Ground-truth rank tracking via paid providers (AppFigures, AppTweak, Sensor Tower)
- Review fetching / sentiment analysis
- A/B test / PPO integration
- Competitor monitoring
- Multi-user / shared DB
- Cloud backup / sync
- Web UI

Each of these deserves its own plan.
