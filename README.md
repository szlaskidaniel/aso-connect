# ASO Connect

**App Store Optimization toolkit for Claude Code** - keyword research, competitor analysis, and metadata management through App Store Connect, all from your terminal.

ASO Connect is an [MCP server](https://modelcontextprotocol.io/) that gives Claude Code (or any MCP client) the ability to score keywords, analyze competitors, and push metadata updates directly to App Store Connect.

## Why

Most ASO tools cost $50-200/month, lock you into a web UI, and still require manual copy-pasting into App Store Connect. ASO Connect gives you:

- **Free keyword scoring** - popularity, difficulty, and opportunity scores powered by iTunes Search API data
- **Direct App Store Connect integration** - read and update titles, subtitles, keywords, descriptions without leaving your terminal
- **AI-native workflow** - Claude analyzes your keywords, suggests improvements, validates constraints, and pushes changes in one conversation

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

ASO Connect includes a `/aso-optimize` slash command that runs a full optimization pipeline - fetches your current metadata, scores keywords, finds better alternatives, optimizes title/subtitle/keywords, and pushes changes to App Store Connect after confirmation.

```
/aso-optimize com.example.myapp
/aso-optimize com.example.myapp de
/aso-optimize com.example.myapp us,de,fr
```

When optimizing for multiple countries, the skill runs the full pipeline for each locale separately with language-specific keywords - German users search in German, French users in French, etc. It won't just translate your English keywords.

The skill is at `.claude/skills/aso-optimize/SKILL.md` and is automatically available when you open the project in Claude Code.

## Example workflow

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
Claude: [runs validate_metadata, then asc_update_version_localization]
        Done - keywords updated in App Store Connect.
```

## How scoring works

**Popularity** (1-100) uses a 6-signal composite model:

- Result count, leader strength (top app ratings), title match density, market depth, specificity penalty, exact phrase bonus

**Difficulty** (1-100) uses 7 weighted factors:

- Rating volume (30%), dominant players (20%), rating quality (10%), market maturity (10%), publisher diversity (10%), app count (10%), content relevance (10%)

**Opportunity** = popularity x (100 - difficulty) / 100

Keywords are classified as: Sweet Spot, Hidden Gem, Good Target, Moderate, High Competition, or Low Volume.

## Notes

- Keywords/description updates require a version in PREPARE_FOR_SUBMISSION state
- Promotional text can be updated on live versions without review
- Name/subtitle changes always require Apple review
- iTunes API rate limit: 1 req/sec (built into the batch tool)
- JWT tokens auto-refresh (15-min lifetime)

## Author

Built by [Daniel Szlaski](https://danielszlaski.com) - indie iOS developer.

## License

MIT

---

Built with Claude Code and the [Model Context Protocol](https://modelcontextprotocol.io/).
