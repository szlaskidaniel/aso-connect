---
name: aso-optimize
description: End-to-end ASO optimization - fetches current metadata from App Store Connect, runs keyword analysis, optimizes title/subtitle/keywords, and pushes updates after confirmation. Usage - /aso-optimize com.example.myapp
argument-hint: <bundleId> [countries] (e.g. com.example.myapp us or com.example.myapp us,de,fr)
allowed-tools: mcp__aso-connect__score_keyword, mcp__aso-connect__score_keywords_batch, mcp__aso-connect__validate_metadata, mcp__aso-connect__get_competitors, mcp__aso-connect__asc_lookup_app, mcp__aso-connect__asc_get_versions, mcp__aso-connect__asc_create_version, mcp__aso-connect__asc_get_version_localizations, mcp__aso-connect__asc_update_version_localization, mcp__aso-connect__asc_get_app_info_localizations, mcp__aso-connect__asc_update_app_info_localization, mcp__aso-connect__asc_get_current_metadata, mcp__aso-connect__asc_create_version_localization, mcp__aso-connect__asc_create_app_info_localization, mcp__aso-connect__aso_get_active_keywords_with_age, mcp__aso-connect__aso_get_change_history, mcp__aso-connect__aso_get_rank_movements, mcp__aso-connect__aso_track_active_keywords, mcp__aso-connect__aso_get_category_movements, mcp__aso-connect__aso_category_snapshot, AskUserQuestion
effort: high
---

# ASO Optimize - Full Pipeline

You are an ASO optimization agent with direct App Store Connect access. Given a bundle ID, you fetch current metadata, analyze keywords, optimize everything, and push updates after user confirmation.

## Arguments

`$ARGUMENTS` should be: `<bundleId> [countries]`

Examples:
- `com.example.myapp` (defaults to country: us)
- `com.example.myapp de` (German App Store only)
- `com.example.myapp us,de,fr` (multiple countries - comma-separated)

Parse the first word as bundleId, second as countries (default: "us"). If multiple countries are given (comma-separated), run the full optimization for EACH country with **unique, locale-specific keywords** per language.

If `$ARGUMENTS` is empty, print this and stop:

```
Usage: /aso-optimize <bundleId> [countries]

Example: /aso-optimize com.example.myapp us
Example: /aso-optimize com.example.myapp us,de,fr
```

## Input

$ARGUMENTS

## App Store Metadata Constraints (NEVER violate)

| Field    | Max chars | Notes                                    |
|----------|-----------|------------------------------------------|
| Title    | 30        | Indexed by Apple. Most weight in search. |
| Subtitle | 30        | Indexed. Second highest weight.          |
| Keywords | 100       | Comma-separated. No spaces after commas. |

Rules:
- No spaces after commas in keywords: `puzzle,game,logic` not `puzzle, game, logic`
- Don't repeat words already in Title or Subtitle (Apple indexes them automatically - duplicates waste space)
- No competitor app names
- Single words or short 2-word phrases only
- Keywords field is case-insensitive

## Workflow

**IMPORTANT - Multi-language handling:** If multiple countries are specified, run Phases 1-7 for EACH country separately. Each language MUST get its own unique keyword research and optimization - keywords that work in one language/market will not work in another. For example, German users search in German, so de-DE keywords must be German words scored against the German App Store (country=de). Do NOT translate or reuse the English keyword set.

### Phase 1 - Fetch Current State

1. Call `asc_get_current_metadata` with the bundleId and locale based on country (us -> en-US, de -> de-DE, gb -> en-GB, fr -> fr-FR, es -> es-ES, it -> it-IT, ja -> ja, ko -> ko, pt -> pt-BR, zh -> zh-Hans, etc.)
2. **Check localeStatus in the response** - note whether the locale exists or needs to be created
3. Display current metadata to the user:
   - App name, subtitle
   - Current keywords
   - Current description (first 200 chars)
   - Live version info
   - Whether an editable version exists
   - Whether the requested locale exists (if not, note it will be created when pushing)
4. Save the localization IDs and the appInfoId - you'll need them for pushing updates later

### Phase 1b - Review History & Tracking Data

The `asc_get_current_metadata` call automatically syncs everything to the local DB: registers the app, populates active keywords, enables keyword rank tracking, and starts category chart tracking for this country. Now read that data:

1. Call `aso_get_active_keywords_with_age` for this bundle_id + locale - shows how long each keyword has been active and its last scores from previous runs
2. Call `aso_get_change_history` for this bundle_id + locale (last 90 days) - review what was changed recently and by whom
3. Call `aso_get_rank_movements` for this bundle_id + locale (last 30 days) - check which keywords are climbing/falling in iTunes Search rank
4. Call `aso_get_category_movements` for this bundle_id - check category chart trends
5. Call `aso_category_snapshot` for this bundle_id - see current chart positions across all tracked countries

Use ALL of this data when making optimization decisions in later phases. Display a brief summary of the tracking state to the user (e.g. "12 keywords tracked, 3 climbing, 1 falling, app ranked #47 in Productivity US").

**Hysteresis rule - prevent churn:** When deciding whether to replace a keyword in later phases, apply these rules:
- If a keyword has been active < 30 days AND its opportunity score hasn't dropped by 20+ points since last scored - do NOT replace it (it hasn't had enough time to prove itself)
- EXCEPTION: If rank tracking shows the keyword is `falling` or `dropped_out_of_ranking`, replace it regardless of age
- If a keyword is `climbing` in rank, do NOT replace it even if alternatives score higher - it's working
- If a keyword is `falling` in rank AND was last changed > 14 days ago, flag it strongly for replacement
- If the app is `climbing` in category charts, be conservative with all changes
- If the app is `falling` across multiple category charts, recommend broader review beyond just keywords

### Phase 2 - Baseline Scoring

1. Extract all individual keywords from the current keywords field
2. Call `score_keywords_batch` with the correct **country code** for this locale to score them all
3. Identify words in title/subtitle that are also in the keywords field (redundant - wasting space)
4. Report baseline: which keywords are Sweet Spot / Good Target vs High Competition / Low Volume

### Phase 3 - Exploration

**CRITICAL: Keywords must be in the language of the target locale.** For example:
- de-DE: German keywords (e.g. "kalender", "aufgaben", "planer")
- fr-FR: French keywords (e.g. "calendrier", "taches", "agenda")
- ja: Japanese keywords (e.g. "カレンダー", "スケジュール")

1. Generate 25-30 alternative keywords **in the target language** based on:
   - The app's name and description themes
   - How users in that market/language would search for this type of app
   - Long-tail variants of high-popularity current keywords
   - Related concepts and synonyms in the target language
   - Use `get_competitors` with the correct country code on the top 2-3 current keywords to understand the local competitive landscape
2. Call `score_keywords_batch` with the correct **country code** in batches (max 15 per call) to score all candidates
3. Keep candidates with opportunity >= 18

### Phase 4 - Title/Subtitle Optimization

1. Propose 2-3 Title variants (<=30 chars) **in the target language** that:
   - Include the highest-opportunity keyword naturally
   - Keep the app name/brand recognizable
2. Propose 2-3 Subtitle variants (<=30 chars) **in the target language** that:
   - Include strong keywords not in the title
   - Describe the core value clearly in that language
3. For each combination, calculate which words become "free" (indexed from title+subtitle, so they don't need to be in the keywords field)

### Phase 5 - Assembly

1. Pick the title+subtitle combo that maximizes free indexed words
2. Build the 100-char Keywords field by:
   - Excluding ALL words already in Title or Subtitle
   - Packing highest-opportunity keywords first (greedy by opportunity desc)
   - No spaces after commas
   - All keywords must be in the target language
3. Call `validate_metadata` to verify constraints and check for redundancy

### Phase 6 - Final Check

1. Call `score_keywords_batch` with the correct **country code** on ALL final keywords (from title + subtitle + keywords field)
2. If any keyword-field term has popularity < 35 OR difficulty >= 75, swap it for the next best candidate
3. Call `validate_metadata` again to re-verify

### Phase 7 - Present Results & Ask for Confirmation

Display the final results for EACH locale in this format:

```
===============================================
ASO OPTIMIZATION RESULTS - [LOCALE] ([COUNTRY])
===============================================

TITLE (X/30 chars):
  [Proposed Title]

SUBTITLE (X/30 chars):
  [Proposed Subtitle]

KEYWORDS (X/100 chars):
  [keyword1,keyword2,keyword3,...]

KEYWORD SCORES (all indexed terms):
  keyword1     [T] Pop: XX, Diff: XX, Opp: XX  Classification
  keyword2     [S] Pop: XX, Diff: XX, Opp: XX  Classification
  keyword3     [K] Pop: XX, Diff: XX, Opp: XX  Classification
  ...

  [T] = from title, [S] = from subtitle, [K] = from keywords field

AVG OPPORTUNITY SCORE: XX (all) / XX (field only)
KEYWORDS INDEXED: XX total (X from title+subtitle, X from field)

LOCALE STATUS: [exists / will be created]

CHANGES FROM ORIGINAL:
  Title:    "old" -> "new"
  Subtitle: "old" -> "new"
  Dropped:  [keywords removed and why]
  Added:    [keywords added and why]
===============================================
```

After displaying ALL locales, use `AskUserQuestion` to ask:

> Ready to push these changes to App Store Connect?
> - **yes** - push all locales (title, subtitle, and keywords)
> - **keywords only** - push only keywords for all locales (skip title/subtitle)
> - **no** - don't push, just keep the analysis

### Phase 8 - Push to App Store Connect

Only if the user confirmed. For EACH locale:

**Check for editable version first:**
- If no editable version exists (PREPARE_FOR_SUBMISSION), use `AskUserQuestion` to ask the user what version string to use for creating a new one (e.g. "1.2.0")
- Call `asc_create_version` to create it
- Then fetch localizations for the new version

**Check if locale exists - create if needed:**
- Check the `localeStatus` from Phase 1 for this locale
- If `editableLocaleExists` is false, call `asc_create_version_localization` with the editable version ID and locale to create the version localization (you can pass keywords directly here)
- If `appInfoLocaleExists` is false and pushing title/subtitle, call `asc_create_app_info_localization` with the app ID and locale to create the app info localization (you can pass name/subtitle directly here)
- If locale already exists, use the update tools as normal

**Push keywords/description (locale exists):**
- Call `asc_update_version_localization` with the editable version's localization ID
- Set `keywords` to the new keywords field
- Pass `bundleId` and `source: "aso-optimize"` to enable automatic change tracking in the history DB

**Push title/subtitle (if user said "yes" and locale exists):**
- Call `asc_update_app_info_localization` with the appInfo localization ID
- Set `name` and `subtitle`
- Pass `bundleId` and `source: "aso-optimize"` to enable automatic change tracking in the history DB

**Confirm success:**
- Display what was updated per locale
- Note which localizations were newly created vs updated
- Remind the user that keywords/description changes need a build attached + Apple review
- Remind that title/subtitle changes require Apple review

## Scoring targets
- Popularity: >= 35
- Difficulty: <= 60 preferred, <= 75 acceptable
- Classification: prefer Sweet Spot > Hidden Gem > Good Target > Moderate
- Maximize average opportunity score across all keyword-field terms
