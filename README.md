# ASO Connect

**Fully automated App Store Optimization for developers.** One command - and Claude fetches your current metadata from App Store Connect, researches and scores keywords, optimizes your title/subtitle/keywords, and pushes the updates back to App Store Connect. No manual work, no context switching.

ASO Connect is an [MCP server](https://modelcontextprotocol.io/) that gives Claude Code the tools to handle the entire ASO workflow end-to-end - from pulling your live metadata to pushing optimized updates - so you can focus on building your app instead of researching keywords.

## Why

ASO is important but tedious. You have to research keywords, cross-reference competitors, check character limits, and then manually copy everything into App Store Connect - for every locale, every update. Most paid tools ($50-200/month) still require you to do the copy-pasting yourself.

ASO Connect eliminates all of that:

- **Zero manual work** - Claude pulls your current metadata, analyzes it, finds better keywords, and pushes changes directly to App Store Connect in one conversation
- **Free keyword scoring** - popularity, difficulty, and opportunity scores powered by iTunes Search API data
- **Multi-locale in one go** - optimizes each language with native keywords (not translations), creating locale localizations automatically when needed
- **Full App Store Connect integration** - reads and writes titles, subtitles, keywords, descriptions, and promotional text without you ever opening a browser

## Prerequisites

- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** - ASO Connect runs as an MCP server inside Claude Code. You need an active Claude Code subscription (Max, Team, or Enterprise) or API credits with Anthropic.
- **Token usage** - all keyword research, analysis, and optimization runs on your Claude tokens. ASO Connect is a free tool, but the AI usage it drives is billed to your account. We are not responsible for token consumption - heavier workflows (multi-locale, large keyword sets) will use more tokens.
- **Node.js 18+**

## Quick start

```bash
# Clone and install
git clone https://github.com/szlaskidaniel/aso-connect.git
cd aso-connect
npm install

# Register with Claude Code (ASO analysis tools work without credentials)
claude mcp add aso-connect -- node $(pwd)/mcp-server.js
```

That's it - you can now ask Claude to score keywords and analyze competitors.

### Adding App Store Connect access

To read/write metadata directly from App Store Connect:

1. Go to [App Store Connect > Users and Access > Integrations > App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a new key with **App Manager** role
3. Download the `.p8` file and note the **Key ID** and **Issuer ID**
4. Re-register with credentials:

```bash
claude mcp remove aso-connect
claude mcp add aso-connect \
  -e ASC_KEY_ID=YOUR_KEY_ID \
  -e ASC_ISSUER_ID=YOUR_ISSUER_ID \
  -e ASC_PRIVATE_KEY_PATH=/path/to/AuthKey_XXXX.p8 \
  -- node /path/to/aso-connect/mcp-server.js
```

## Security - your keys never leave your machine

Unlike SaaS ASO tools that require you to upload your App Store Connect API key to a third-party server, ASO Connect runs entirely on your machine. Your `.p8` file stays local, JWT signing happens locally, and API calls go directly from your machine to Apple. There is no middleman, no server, and no third-party ever sees your credentials.

This matters because ASO Connect needs an **App Manager** key - a high-privilege credential that can modify your app metadata. With a local MCP server, you get full write access to App Store Connect without trusting anyone else with your keys.

## Tools

### ASO Analysis (no credentials needed)

| Tool                   | What it does                                                 |
| ---------------------- | ------------------------------------------------------------ |
| `score_keyword`        | Score a single keyword - popularity, difficulty, opportunity |
| `score_keywords_batch` | Score up to 15 keywords at once, ranked by opportunity       |
| `validate_metadata`    | Check title/subtitle/keywords against App Store constraints  |
| `get_competitors`      | Pull competitor data from iTunes Search API                  |

### App Store Connect (requires API key)

| Tool                               | What it does                                            |
| ---------------------------------- | ------------------------------------------------------- |
| `asc_lookup_app`                   | Find your app by bundle ID                              |
| `asc_get_versions`                 | List versions, filter by state                          |
| `asc_create_version`               | Create a new version (PREPARE_FOR_SUBMISSION)           |
| `asc_get_version_localizations`    | Get keywords/description/whatsNew per locale            |
| `asc_create_version_localization`  | Add a new locale to a version                           |
| `asc_update_version_localization`  | Update keywords, description, whatsNew, promotionalText |
| `asc_get_app_info_localizations`   | Get name/subtitle per locale                            |
| `asc_create_app_info_localization` | Add a new locale for app info                           |
| `asc_update_app_info_localization` | Update name and/or subtitle                             |
| `asc_get_current_metadata`         | Fetch all current metadata for a bundle ID in one call  |

## Claude Code skill

ASO Connect includes a `/aso-optimize` slash command that runs the entire optimization pipeline automatically - from fetching your current metadata to pushing updated keywords back to App Store Connect. What normally takes hours of manual research and copy-pasting happens in a single conversation.

```
/aso-optimize com.example.myapp
/aso-optimize com.example.myapp de
/aso-optimize com.example.myapp us,de,fr
```

When optimizing for multiple countries, the skill runs the full pipeline for each locale separately with language-specific keywords - German users search in German, French users in French, etc. It won't just translate your English keywords.

The skill is at `.claude/skills/aso-optimize/SKILL.md` and is automatically available when you open the project in Claude Code.

## Example workflow

### One-command optimization

```
You:    /aso-optimize com.example.habitapp
Claude: [fetches current metadata from App Store Connect]
        [scores your existing keywords - finds 3 are high competition]
        [researches 40+ alternatives, scores each one]
        [optimizes title, subtitle, and keyword field]
        [validates everything fits App Store constraints]
        Here's what I'd change:
          Title: "Habit Streaks - Daily Routine Tracker" (was: "My Habit App")
          Subtitle: "Build routines & track goals" (was: "Track your habits")
          Keywords: habit streaks,routine planner,daily goals,...
        Push these updates to App Store Connect?

You:    Yes
Claude: [pushes updates directly to App Store Connect]
        Done - metadata updated for v2.1.
```

### Step-by-step (if you prefer more control)

```
You:    Score my current keywords: "habit tracker,daily routine,goals"
Claude: [runs score_keywords_batch] Here are the results...
        "habit tracker" has high competition (difficulty: 78).
        "daily routine" is a sweet spot - decent traffic, low competition.
        Want me to find alternatives for the competitive ones?

You:    Yes, find better keywords for a habit tracking app
Claude: [runs multiple score_keyword calls]
        Found some opportunities:
        - "habit streaks" (pop: 42, diff: 22) - Sweet Spot
        - "routine planner" (pop: 35, diff: 18) - Hidden Gem
        ...

You:    Update my keywords with those
Claude: [validates constraints, then pushes to App Store Connect]
        Done - keywords updated.

You:    Update what's new section for all localizations (in their languages) "Minor corrections"
Claude: Done. "What's New" updated for all three locales:
        - en-US: Minor corrections.
        - pl: Drobne poprawki.
        - de-DE: Kleinere Korrekturen.
```

## How scoring works

**Popularity** (1-100) uses a 6-signal composite model:

- Result count, leader strength (top app ratings), title match density, market depth, specificity penalty, exact phrase bonus

**Difficulty** (1-100) uses 7 weighted factors:

- Rating volume (30%), dominant players (20%), rating quality (10%), market maturity (10%), publisher diversity (10%), app count (10%), content relevance (10%)

**Opportunity** = popularity x (100 - difficulty) / 100

Keywords are classified as: Sweet Spot, Hidden Gem, Good Target, Moderate, High Competition, or Low Volume.

## Notes

- Promotional text can be updated on live versions without review
- Name/subtitle changes always require Apple review
- iTunes API rate limit: 1 req/sec (built into the batch tool)
- JWT tokens auto-refresh (15-min lifetime)

## Author

Built by [Daniel Szlaski](https://danielszlaski.com) - indie iOS developer.

## License

AGPL-3.0

---

Built with Claude Code and the [Model Context Protocol](https://modelcontextprotocol.io/).
