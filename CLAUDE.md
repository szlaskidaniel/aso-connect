# ASO Connect - Unified MCP Server

ASO keyword analysis + App Store Connect API + local history/rank tracking in a single MCP server.

## Setup

### 1. Install dependencies

```bash
npm install
```

This installs `@modelcontextprotocol/sdk`, `jose` (JWT signing), and `better-sqlite3` (local history DB).

### 2. Add App Store Connect credentials (optional)

1. Go to [App Store Connect > Users and Access > Integrations > App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Click "+" to generate a new key with **App Manager** role
3. Download the `.p8` file (one-time download) and place it in the project root
4. Run `node setup.js` - it auto-detects the key file and extracts the Key ID

ASO analysis tools (score_keyword, score_keywords_batch, etc.) work without credentials.
App Store Connect tools (asc_*) require the setup above.

### 3. Run tests

```bash
npm test
```

## Tools

### ASO Analysis (no auth needed)

| Tool | Description |
|---|---|
| `score_keyword` | Score a single keyword (popularity, difficulty, opportunity) |
| `score_keywords_batch` | Score up to 15 keywords, sorted by opportunity |
| `validate_metadata` | Check title/subtitle/keywords constraints and redundancy |
| `get_competitors` | Fetch competitor data from iTunes Search API |

### App Store Connect (requires API key)

| Tool | Description |
|---|---|
| `asc_lookup_app` | Find app by bundle ID |
| `asc_get_versions` | List versions, filter by state |
| `asc_create_version` | Create new version (PREPARE_FOR_SUBMISSION) |
| `asc_get_version_localizations` | Get keywords/description/whatsNew per locale |
| `asc_create_version_localization` | Create a new locale for a version (needed before updating non-primary locales) |
| `asc_update_version_localization` | Update keywords, description, whatsNew, promotionalText. Pass `bundleId` + `source` for change tracking. |
| `asc_get_app_info_localizations` | Get name/subtitle per locale |
| `asc_create_app_info_localization` | Create a new locale for app info (needed before updating non-primary locales) |
| `asc_update_app_info_localization` | Update name and/or subtitle. Pass `bundleId` + `source` for change tracking. |
| `asc_get_current_metadata` | Convenience: fetch all current metadata for a bundle ID (includes locale existence status) |

### History & Introspection (local SQLite, no auth needed)

| Tool | Description |
|---|---|
| `aso_db_stats` | Overview of local history DB - tracked apps, change counts, keyword counts |
| `aso_get_change_history` | Get metadata change history for an app (what changed, when, by whom) |
| `aso_get_active_keywords_with_age` | Active keywords with age in days, last scores, time since scored |
| `aso_get_keyword_score_history` | Current state + score time-series snapshots for a specific keyword |
| `aso_snapshot_keywords` | Score keywords and persist snapshots for time-series tracking |
| `aso_keyword_trend` | Score time-series for a keyword over time |

### Rank Tracking (iTunes Search API, no auth needed)

| Tool | Description |
|---|---|
| `aso_track_keyword` | Add a keyword to rank tracking, immediately fetches initial rank |
| `aso_track_active_keywords` | Bulk-add all active keywords for an app+locale to rank tracking |
| `aso_untrack_keyword` | Remove keyword from rank tracking (historical data preserved) |
| `aso_refresh_ranks` | Fetch current ranks for all tracked keywords (skips fresh ones) |
| `aso_get_rank_history` | Rank time-series for a keyword |
| `aso_get_rank_movements` | Detect meaningful rank movements with noise filtering |

### Category Chart Tracking (Apple RSS feeds, no auth needed)

| Tool | Description |
|---|---|
| `aso_track_chart` | Start tracking app position in a category chart |
| `aso_track_app_categories` | Bulk-add chart tracking across multiple countries |
| `aso_refresh_category_ranks` | Fetch current chart positions for all tracked charts |
| `aso_get_category_rank_history` | Chart position time-series |
| `aso_get_category_movements` | Detect meaningful chart position movements |
| `aso_category_snapshot` | Current position across all tracked charts for an app |

## Typical workflow

### Optimization (or use `/aso-optimize` for the full pipeline)

1. `asc_get_current_metadata` - fetch current title/subtitle/keywords (auto-syncs app + active keywords to local DB)
2. `aso_get_active_keywords_with_age` - check keyword ages and last scores from previous runs
3. `aso_get_change_history` - review recent metadata changes
4. `score_keywords_batch` - score current keywords (auto-caches scores to active_keywords)
5. Run ASO analysis rounds to find better keywords (respecting hysteresis - don't replace keywords < 30 days old unless declining)
6. `validate_metadata` - verify new combination fits constraints
7. `asc_update_version_localization` - push keywords/description (pass `bundleId` + `source` for change tracking)
8. `asc_update_app_info_localization` - push name/subtitle (pass `bundleId` + `source` for change tracking)

### Rank monitoring (run periodically or via cron)

1. `aso_track_active_keywords` - add all current keywords to rank tracking
2. `aso_track_app_categories` - add category chart tracking
3. `aso_refresh_ranks` / `aso_refresh_category_ranks` - fetch current positions
4. `aso_get_rank_movements` / `aso_get_category_movements` - detect meaningful changes
5. Or run `node scripts/refresh-all.js` via cron for unattended daily refreshes

## Architecture

```
mcp-server.js          - MCP tool definitions (31 tools)
appstore-connect.js    - ASC API client with JWT auth
scoring.js             - Keyword popularity/difficulty/opportunity scoring
lib/
  db.js                - SQLite singleton (WAL mode, .aso-connect/aso.db)
  schema.js            - Idempotent schema init, version guard (v2)
  rankFetcher.js       - iTunes Search API rank lookups
  categoryFetcher.js   - Apple RSS chart fetchers (overall + genre)
  genres.js            - App Store genre ID constants
  repos/
    apps.js            - App registry (upsert on lookup)
    metadataChanges.js - Change log (field-level diffs)
    activeKeywords.js  - Current keyword set with scores/ages
    keywordSnapshots.js- Score time-series
    ranks.js           - Keyword SERP rank tracking + movement detection
    categoryRanks.js   - Category chart rank tracking + movement detection
test/
  repos.test.js        - 33 tests using node:test + in-memory SQLite
scripts/
  refresh-all.js       - Standalone cron script for daily rank/chart refresh
```

## Notes

### App Store Connect

- Keywords/description updates require a version in PREPARE_FOR_SUBMISSION state
- Promotional text can be updated on live versions without review
- Name/subtitle changes always require Apple review
- By default only the primary locale (usually en-US) exists - you must create other locale localizations before updating them
- `asc_get_current_metadata` returns `localeStatus` showing which locales exist and which need creation
- When optimizing for multiple languages, each locale needs its own keyword research in that language - do not reuse or translate English keywords

### Local history DB

- Stored at `.aso-connect/aso.db` (gitignored), SQLite WAL mode, schema v2
- All timestamps stored as Unix ms integers (`Date.now()`)
- `asc_get_current_metadata` auto-syncs app + active keywords to local DB on every call
- `score_keyword` / `score_keywords_batch` auto-cache scores to `active_keywords` for any keyword that's currently tracked
- `asc_update_version_localization` and `asc_update_app_info_localization` log field-level diffs when `bundleId` and `source` params are passed
- Valid `source` values: `aso-optimize`, `manual`, `rollback`, `import`
- Valid `field` values: `name`, `subtitle`, `keywords`, `description`, `whats_new`, `promotional_text`
- If a user deletes `.aso-connect/aso.db`, the next startup recreates it silently

### Hysteresis (churn prevention)

- Keywords active < 30 days with stable scores (opportunity hasn't dropped 20+ points) are protected from replacement
- Exception: rank data showing `falling` or `dropped_out_of_ranking` overrides age protection
- Keywords with `climbing` rank are never replaced, even if alternatives score higher

### Rank tracking

- iTunes Search API returns up to 200 results per keyword query - not identical to what users see in the App Store (Apple applies personalization), but reliable for detecting movement
- Noise filtering: minimum 5-position delta for rank <= 50, 10% of old rank for rank > 50; null transitions (ranked/unranked) always reported
- Category charts use stricter thresholds (minimum 3 positions) since they're more stable

### Rate limits & scheduling

- iTunes API rate limit: 1 request/second (built into batch tools and refresh scripts)
- JWT tokens auto-refresh (15min lifetime, refreshed at 14min)
- `aso_refresh_ranks` and `aso_refresh_category_ranks` skip keywords/charts tracked within `stale_hours` (default 20h)
- Scheduled refresh: `node scripts/refresh-all.js` via cron for daily unattended updates
