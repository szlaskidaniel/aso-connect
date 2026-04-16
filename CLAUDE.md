# ASO Connect - Unified MCP Server

ASO keyword analysis + App Store Connect API in a single MCP server.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Add App Store Connect credentials (optional)

1. Go to [App Store Connect > Users and Access > Integrations > App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Click "+" to generate a new key with **App Manager** role
3. Download the `.p8` file (one-time download) and place it in the project root
4. Run `node setup.js` - it auto-detects the key file and extracts the Key ID

ASO analysis tools (score_keyword, score_keywords_batch, etc.) work without credentials.
App Store Connect tools (asc_*) require the setup above.

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
| `asc_update_version_localization` | Update keywords, description, whatsNew, promotionalText |
| `asc_get_app_info_localizations` | Get name/subtitle per locale |
| `asc_create_app_info_localization` | Create a new locale for app info (needed before updating non-primary locales) |
| `asc_update_app_info_localization` | Update name and/or subtitle |
| `asc_get_current_metadata` | Convenience: fetch all current metadata for a bundle ID (includes locale existence status) |

## Typical workflow

1. `asc_get_current_metadata` - fetch current title/subtitle/keywords
2. `score_keywords_batch` - score current keywords
3. Run ASO analysis rounds to find better keywords
4. `validate_metadata` - verify new combination fits constraints
5. `asc_update_version_localization` - push keywords/description
6. `asc_update_app_info_localization` - push name/subtitle

## Notes

- Keywords/description updates require a version in PREPARE_FOR_SUBMISSION state
- Promotional text can be updated on live versions without review
- Name/subtitle changes always require Apple review
- iTunes API rate limit: 1 request/second (built into batch tool)
- JWT tokens auto-refresh (15min lifetime, refreshed at 14min)
- By default only the primary locale (usually en-US) exists - you must create other locale localizations before updating them
- `asc_get_current_metadata` returns `localeStatus` showing which locales exist and which need creation
- When optimizing for multiple languages, each locale needs its own keyword research in that language - do not reuse or translate English keywords
