// mcp-server.js
// Unified ASO analysis + App Store Connect MCP server
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { computePopularity, computeDifficulty, classify, difficultyLabel } from './scoring.js';
import { AppStoreConnectClient } from './appstore-connect.js';
import { statSync } from 'fs';
import { getDb, getDbPath } from './lib/db.js';
import { initSchema, EXPECTED_SCHEMA_VERSION } from './lib/schema.js';
import { upsertApp, getApp, listApps } from './lib/repos/apps.js';
import { logChange, getChangesFor, getLastChange } from './lib/repos/metadataChanges.js';
import { setActiveKeywords, getActiveKeywords, updateKeywordScore, getKeywordAge } from './lib/repos/activeKeywords.js';
import { appendSnapshot, getHistory as getSnapshotHistory } from './lib/repos/keywordSnapshots.js';
import { addTrackedKeyword, removeTrackedKeyword, listTrackedKeywords, recordRank, getRankHistory, getLatestRank, getRankMovements } from './lib/repos/ranks.js';
import { addTrackedChart, removeTrackedChart, listTrackedCharts, recordCategoryRank, getCategoryRankHistory, getLatestCategoryRank, getCategoryMovements } from './lib/repos/categoryRanks.js';
import { fetchRank } from './lib/rankFetcher.js';
import { fetchCategoryRank, fetchOverallChart, fetchGenreChart } from './lib/categoryFetcher.js';
import { genreName } from './lib/genres.js';

// -- iTunes helpers ---------------------------------------------------------

const ITUNES_BASE = 'https://itunes.apple.com/search';
const DELAY_MS = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchItunesResults(keyword, country = 'us', limit = 25) {
  const url = `${ITUNES_BASE}?term=${encodeURIComponent(keyword)}&country=${country}&entity=software&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes API error: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

async function scoreKeyword(keyword, country = 'us') {
  const results = await fetchItunesResults(keyword, country);
  const popularity = computePopularity(results, keyword);
  const difficulty = computeDifficulty(results, keyword);
  const { label, opportunity } = classify(popularity, difficulty);

  const topCompetitors = results.slice(0, 5).map(a => ({
    name: a.trackName,
    ratings: a.userRatingCount || 0,
    stars: +(a.averageUserRating || 0).toFixed(2),
    released: (a.releaseDate || '').slice(0, 4),
    genre: a.primaryGenreName,
  }));

  return {
    keyword, country, popularity, difficulty,
    difficultyLabel: difficultyLabel(difficulty),
    opportunity, classification: label,
    resultCount: results.length, topCompetitors,
  };
}

// -- App Store Connect client (lazy init) -----------------------------------

let ascClient = null;

function getASCClient() {
  if (!ascClient) {
    const keyId = process.env.ASC_KEY_ID;
    const issuerId = process.env.ASC_ISSUER_ID;
    const privateKeyPath = process.env.ASC_PRIVATE_KEY_PATH;

    if (!keyId || !issuerId || !privateKeyPath) {
      throw new Error(
        'App Store Connect credentials not configured. Set env vars: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH'
      );
    }
    ascClient = new AppStoreConnectClient({ keyId, issuerId, privateKeyPath });
  }
  return ascClient;
}

function jsonResponse(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// -- Database init ----------------------------------------------------------

try {
  initSchema(getDb());
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// -- MCP Server -------------------------------------------------------------

const server = new McpServer({
  name: 'aso-connect',
  version: '1.0.0',
});

// ============================================================================
// ASO ANALYSIS TOOLS
// ============================================================================

server.tool(
  'score_keyword',
  'Score a single App Store keyword for popularity, difficulty, and opportunity',
  {
    keyword: z.string().describe('App Store keyword to score'),
    country: z.string().default('us').describe('ISO country code (default: us)'),
  },
  async ({ keyword, country }) => {
    const result = await scoreKeyword(keyword, country);
    try {
      const db = getDb();
      db.prepare(`
        UPDATE active_keywords
        SET last_score_popularity = ?, last_score_difficulty = ?, last_score_opportunity = ?, last_scored_at = ?
        WHERE keyword = ?
      `).run(result.popularity, result.difficulty, result.opportunity, Date.now(), keyword);
    } catch {}
    return jsonResponse(result);
  }
);

server.tool(
  'score_keywords_batch',
  'Score multiple keywords in one call (max 15). Returns sorted by opportunity.',
  {
    keywords: z.array(z.string()).describe('List of keywords to score (max 15)'),
    country: z.string().default('us').describe('ISO country code'),
  },
  async ({ keywords, country }) => {
    const results = [];
    const batch = keywords.slice(0, 15);

    for (const kw of batch) {
      try {
        results.push(await scoreKeyword(kw, country));
      } catch (e) {
        results.push({ keyword: kw, error: e.message });
      }
      if (batch.indexOf(kw) < batch.length - 1) await sleep(DELAY_MS);
    }

    try {
      const db = getDb();
      const stmt = db.prepare(`
        UPDATE active_keywords
        SET last_score_popularity = ?, last_score_difficulty = ?, last_score_opportunity = ?, last_scored_at = ?
        WHERE keyword = ?
      `);
      const now = Date.now();
      for (const r of results) {
        if (r.error) continue;
        stmt.run(r.popularity, r.difficulty, r.opportunity, now, r.keyword);
      }
    } catch {}

    results.sort((a, b) => (b.opportunity || 0) - (a.opportunity || 0));

    const summary = results.map(r => ({
      keyword: r.keyword,
      popularity: r.popularity,
      difficulty: r.difficulty,
      opportunity: r.opportunity,
      classification: r.classification,
    }));

    return jsonResponse({ summary, full: results });
  }
);

server.tool(
  'validate_metadata',
  'Validate App Store metadata constraints (char limits, redundancy, formatting)',
  {
    title: z.string().describe('App title (max 30 chars)'),
    subtitle: z.string().describe('App subtitle (max 30 chars)'),
    keywords: z.string().describe('Keywords field (max 100 chars, comma-separated, no spaces)'),
  },
  async ({ title, subtitle, keywords }) => {
    const errors = [];
    const warnings = [];

    if (title.length > 30) errors.push(`Title too long: ${title.length}/30 chars`);
    if (subtitle.length > 30) errors.push(`Subtitle too long: ${subtitle.length}/30 chars`);
    if (keywords.length > 100) errors.push(`Keywords too long: ${keywords.length}/100 chars`);

    if (keywords.includes(', ')) warnings.push('Keywords should not have spaces after commas');

    const titleWords = title.toLowerCase().split(/\s+/);
    const subtitleWords = subtitle.toLowerCase().split(/\s+/);
    const usedWords = [...titleWords, ...subtitleWords];
    const kwList = keywords.split(',').map(k => k.trim().toLowerCase());

    const redundant = kwList.filter(kw =>
      usedWords.some(w => kw === w || kw.includes(w))
    );
    if (redundant.length > 0) {
      warnings.push(`Redundant keywords (already in title/subtitle): ${redundant.join(', ')}`);
    }

    return jsonResponse({
      valid: errors.length === 0,
      errors, warnings,
      charCounts: {
        title: `${title.length}/30`,
        subtitle: `${subtitle.length}/30`,
        keywords: `${keywords.length}/100`,
        keywordsRemaining: 100 - keywords.length,
      },
      keywordCount: kwList.length,
    });
  }
);

server.tool(
  'get_competitors',
  'Get competitor apps from iTunes Search API for a keyword',
  {
    keyword: z.string().describe('Keyword to look up competitors for'),
    country: z.string().default('us'),
    limit: z.number().default(10).describe('Number of competitors to return (max 25)'),
  },
  async ({ keyword, country, limit }) => {
    const results = await fetchItunesResults(keyword, country, Math.min(limit, 25));
    const competitors = results.map((a, i) => ({
      rank: i + 1,
      name: a.trackName,
      seller: a.sellerName,
      ratings: a.userRatingCount || 0,
      stars: +(a.averageUserRating || 0).toFixed(2),
      genre: a.primaryGenreName,
      released: (a.releaseDate || '').slice(0, 10),
      price: a.formattedPrice,
      bundleId: a.bundleId,
      titleHasKeyword: (a.trackName || '').toLowerCase().includes(keyword.toLowerCase()),
    }));

    return jsonResponse({ keyword, country, competitors });
  }
);

// ============================================================================
// APP STORE CONNECT TOOLS
// ============================================================================

server.tool(
  'asc_lookup_app',
  'Look up an app in App Store Connect by bundle ID. Returns app ID, name, and current versions/info.',
  {
    bundleId: z.string().describe('The app bundle ID (e.g. com.example.myapp)'),
  },
  async ({ bundleId }) => {
    const client = getASCClient();
    const app = await client.lookupAppByBundleId(bundleId);

    upsertApp(getDb(), bundleId, { name: app.name });

    const versions = (app.included || [])
      .filter(r => r.type === 'appStoreVersions')
      .map(v => ({
        id: v.id,
        version: v.attributes.versionString,
        state: v.attributes.appStoreState,
        platform: v.attributes.platform,
      }));

    const appInfos = (app.included || [])
      .filter(r => r.type === 'appInfos')
      .map(i => ({ id: i.id, state: i.attributes.appStoreState }));

    return jsonResponse({
      id: app.id,
      name: app.name,
      bundleId: app.bundleId,
      sku: app.sku,
      primaryLocale: app.primaryLocale,
      versions,
      appInfos,
    });
  }
);

server.tool(
  'asc_get_versions',
  'List App Store versions for an app. Optionally filter by state (e.g. PREPARE_FOR_SUBMISSION, READY_FOR_DISTRIBUTION).',
  {
    appId: z.string().describe('App Store Connect app ID'),
    state: z.string().optional().describe('Filter by version state'),
    platform: z.string().default('IOS').describe('Platform (IOS, MAC_OS, TV_OS)'),
  },
  async ({ appId, state, platform }) => {
    const client = getASCClient();
    const versions = await client.getAppVersions(appId, { state, platform });
    return jsonResponse({ appId, versions });
  }
);

server.tool(
  'asc_create_version',
  'Create a new App Store version in PREPARE_FOR_SUBMISSION state. Required before updating keywords/description.',
  {
    appId: z.string().describe('App Store Connect app ID'),
    versionString: z.string().describe('Version string (e.g. "2.1.0")'),
    platform: z.string().default('IOS').describe('Platform (IOS, MAC_OS, TV_OS)'),
  },
  async ({ appId, versionString, platform }) => {
    const client = getASCClient();
    const version = await client.createVersion(appId, versionString, platform);
    return jsonResponse(version);
  }
);

server.tool(
  'asc_get_version_localizations',
  'Get all localizations for a version (description, keywords, whatsNew, promotionalText per locale).',
  {
    versionId: z.string().describe('App Store version ID'),
  },
  async ({ versionId }) => {
    const client = getASCClient();
    const localizations = await client.getVersionLocalizations(versionId);
    return jsonResponse({ versionId, localizations });
  }
);

server.tool(
  'asc_create_version_localization',
  'Create a new locale for a version. Automatically copies description, promotionalText, supportUrl, and marketingUrl from the primary locale unless explicitly provided.',
  {
    versionId: z.string().describe('App Store version ID'),
    locale: z.string().describe('Locale to create (e.g. de-DE, fr-FR, ja)'),
    keywords: z.string().optional().describe('Initial keywords'),
    description: z.string().optional().describe('Initial description (defaults to primary locale)'),
    whatsNew: z.string().optional().describe('Initial whatsNew text'),
    promotionalText: z.string().optional().describe('Initial promotional text (defaults to primary locale)'),
    supportUrl: z.string().optional().describe('Support URL (defaults to primary locale)'),
    marketingUrl: z.string().optional().describe('Marketing URL (defaults to primary locale)'),
  },
  async ({ versionId, locale, keywords, description, whatsNew, promotionalText, supportUrl, marketingUrl }) => {
    const client = getASCClient();

    // Fetch primary locale data to use as defaults
    const existingLocs = await client.getVersionLocalizations(versionId);
    const primaryLoc = existingLocs[0] || {};

    const attrs = {};
    if (keywords !== undefined) attrs.keywords = keywords;
    attrs.description = description !== undefined ? description : (primaryLoc.description || undefined);
    attrs.promotionalText = promotionalText !== undefined ? promotionalText : (primaryLoc.promotionalText || undefined);
    attrs.supportUrl = supportUrl !== undefined ? supportUrl : (primaryLoc.supportUrl || undefined);
    attrs.marketingUrl = marketingUrl !== undefined ? marketingUrl : (primaryLoc.marketingUrl || undefined);
    if (whatsNew !== undefined) attrs.whatsNew = whatsNew;

    // Remove undefined values
    for (const key of Object.keys(attrs)) {
      if (attrs[key] === undefined) delete attrs[key];
    }

    const result = await client.createVersionLocalization(versionId, locale, attrs);
    return jsonResponse(result);
  }
);

server.tool(
  'asc_create_app_info_localization',
  'Create a new locale for app info (name/subtitle). Use when a locale does not yet exist (e.g. only en-US exists by default). Must create before you can update.',
  {
    appId: z.string().describe('App Store Connect app ID'),
    locale: z.string().describe('Locale to create (e.g. de-DE, fr-FR, ja)'),
    name: z.string().optional().describe('App name for this locale'),
    subtitle: z.string().optional().describe('App subtitle for this locale'),
  },
  async ({ appId, locale, name, subtitle }) => {
    const attrs = {};
    if (name !== undefined) attrs.name = name;
    if (subtitle !== undefined) attrs.subtitle = subtitle;

    const client = getASCClient();

    // Get the appropriate appInfo (prefer editable)
    const appInfos = await client.getAppInfos(appId);
    if (appInfos.length === 0) {
      return jsonResponse({ error: 'No appInfo found for this app' });
    }
    const editable = appInfos.find(i => i.state !== 'READY_FOR_SALE');
    const appInfo = editable || appInfos[0];

    const result = await client.createAppInfoLocalization(appInfo.id, locale, attrs);
    return jsonResponse(result);
  }
);

server.tool(
  'asc_update_version_localization',
  'Update version-level metadata: keywords, description, whatsNew, promotionalText, supportUrl, marketingUrl. Version must be in PREPARE_FOR_SUBMISSION state (except promotionalText which can always be updated).',
  {
    localizationId: z.string().describe('Version localization ID'),
    keywords: z.string().optional().describe('Comma-separated keywords (max 100 chars, no spaces after commas)'),
    description: z.string().optional().describe('App description'),
    whatsNew: z.string().optional().describe('What\'s new text for this version'),
    promotionalText: z.string().optional().describe('Promotional text (can be updated without review)'),
    supportUrl: z.string().optional().describe('Support URL'),
    marketingUrl: z.string().optional().describe('Marketing URL'),
    bundleId: z.string().optional().describe('Bundle ID for change tracking (optional - enables history logging)'),
    source: z.string().optional().default('manual').describe('Change source for history (aso-optimize, manual, rollback, import)'),
  },
  async ({ localizationId, keywords, description, whatsNew, promotionalText, supportUrl, marketingUrl, bundleId, source }) => {
    const attrs = {};
    if (keywords !== undefined) attrs.keywords = keywords;
    if (description !== undefined) attrs.description = description;
    if (whatsNew !== undefined) attrs.whatsNew = whatsNew;
    if (promotionalText !== undefined) attrs.promotionalText = promotionalText;
    if (supportUrl !== undefined) attrs.supportUrl = supportUrl;
    if (marketingUrl !== undefined) attrs.marketingUrl = marketingUrl;

    if (Object.keys(attrs).length === 0) {
      return jsonResponse({ error: 'No attributes provided to update' });
    }

    const client = getASCClient();

    let oldValues = null;
    if (bundleId) {
      try { oldValues = await client.getVersionLocalization(localizationId); } catch {}
    }

    const result = await client.updateVersionLocalization(localizationId, attrs);

    if (bundleId && oldValues) {
      const db = getDb();
      const locale = oldValues.locale;
      const fieldMap = {
        keywords: 'keywords', description: 'description',
        whatsNew: 'whats_new', promotionalText: 'promotional_text',
      };
      for (const [attrKey, dbField] of Object.entries(fieldMap)) {
        if (attrs[attrKey] !== undefined && attrs[attrKey] !== oldValues[attrKey]) {
          logChange(db, { bundleId, locale, field: dbField, oldValue: oldValues[attrKey], newValue: attrs[attrKey], source });
        }
      }
    }

    return jsonResponse(result);
  }
);

server.tool(
  'asc_get_app_info_localizations',
  'Get app-level localizations (name, subtitle) for an appInfo.',
  {
    appId: z.string().describe('App Store Connect app ID'),
  },
  async ({ appId }) => {
    const client = getASCClient();
    const appInfos = await client.getAppInfos(appId);
    if (appInfos.length === 0) {
      return jsonResponse({ error: 'No appInfo found' });
    }

    // Prefer editable appInfo (PREPARE_FOR_SUBMISSION) over live one
    const editable = appInfos.find(i => i.state !== 'READY_FOR_SALE');
    const appInfo = editable || appInfos[0];
    const localizations = await client.getAppInfoLocalizations(appInfo.id);
    return jsonResponse({ appId, appInfoId: appInfo.id, state: appInfo.state, allAppInfos: appInfos, localizations });
  }
);

server.tool(
  'asc_update_app_info_localization',
  'Update app-level metadata: name and/or subtitle. Changes require Apple review.',
  {
    localizationId: z.string().describe('App info localization ID'),
    name: z.string().optional().describe('App name (max 30 chars)'),
    subtitle: z.string().optional().describe('App subtitle (max 30 chars)'),
    bundleId: z.string().optional().describe('Bundle ID for change tracking (optional - enables history logging)'),
    source: z.string().optional().default('manual').describe('Change source for history (aso-optimize, manual, rollback, import)'),
  },
  async ({ localizationId, name, subtitle, bundleId, source }) => {
    const attrs = {};
    if (name !== undefined) attrs.name = name;
    if (subtitle !== undefined) attrs.subtitle = subtitle;

    if (Object.keys(attrs).length === 0) {
      return jsonResponse({ error: 'No attributes provided to update' });
    }

    const client = getASCClient();

    let oldValues = null;
    if (bundleId) {
      try { oldValues = await client.getAppInfoLocalization(localizationId); } catch {}
    }

    const result = await client.updateAppInfoLocalization(localizationId, attrs);

    if (bundleId && oldValues) {
      const db = getDb();
      const locale = oldValues.locale;
      for (const field of ['name', 'subtitle']) {
        if (attrs[field] !== undefined && attrs[field] !== oldValues[field]) {
          logChange(db, { bundleId, locale, field, oldValue: oldValues[field], newValue: attrs[field], source });
        }
      }
    }

    return jsonResponse(result);
  }
);

// ============================================================================
// COMBINED WORKFLOW TOOL
// ============================================================================

server.tool(
  'asc_get_current_metadata',
  'Convenience tool: fetch current live metadata (name, subtitle, keywords, description) for an app by bundle ID. Combines multiple API calls.',
  {
    bundleId: z.string().describe('The app bundle ID'),
    locale: z.string().default('en-US').describe('Locale to fetch (default: en-US)'),
  },
  async ({ bundleId, locale }) => {
    const client = getASCClient();

    const app = await client.lookupAppByBundleId(bundleId);
    upsertApp(getDb(), bundleId, { name: app.name });

    // Step 2: Get live version
    const versions = await client.getAppVersions(app.id, { state: 'READY_FOR_DISTRIBUTION' });
    const editableVersions = await client.getAppVersions(app.id, { state: 'PREPARE_FOR_SUBMISSION' });

    // Step 3: Get version localizations from live version
    let versionMeta = null;
    let versionLocaleExists = false;
    let allVersionLocales = [];
    if (versions.length > 0) {
      const locs = await client.getVersionLocalizations(versions[0].id);
      allVersionLocales = locs.map(l => l.locale);
      const exact = locs.find(l => l.locale === locale);
      versionLocaleExists = !!exact;
      versionMeta = exact || locs[0] || null;
    }

    // Step 4: Also check editable version if exists
    let editableMeta = null;
    let editableLocaleExists = false;
    let allEditableLocales = [];
    if (editableVersions.length > 0) {
      const locs = await client.getVersionLocalizations(editableVersions[0].id);
      allEditableLocales = locs.map(l => l.locale);
      const exact = locs.find(l => l.locale === locale);
      editableLocaleExists = !!exact;
      editableMeta = exact || locs[0] || null;
    }

    // Step 5: Get app info localizations (name, subtitle)
    const appInfos = await client.getAppInfos(app.id);
    let appInfoMeta = null;
    let appInfoLocaleExists = false;
    let allAppInfoLocales = [];
    if (appInfos.length > 0) {
      const locs = await client.getAppInfoLocalizations(appInfos[0].id);
      allAppInfoLocales = locs.map(l => l.locale);
      const exact = locs.find(l => l.locale === locale);
      appInfoLocaleExists = !!exact;
      appInfoMeta = exact || locs[0] || null;
    }

    // Sync active keywords + auto-enable rank/chart tracking
    const db = getDb();
    const kwSource = editableMeta?.keywords || versionMeta?.keywords;
    if (kwSource) {
      const parsed = kwSource.split(',').map(k => k.trim()).filter(Boolean);
      if (parsed.length > 0) {
        setActiveKeywords(db, bundleId, locale, parsed);
        for (const kw of parsed) addTrackedKeyword(db, bundleId, kw, locale);
      }
    }

    // Auto-track overall top-free chart for this locale's country
    const country = locale.length === 2 ? locale.toLowerCase() : (locale.split(/[-_]/)[1] || locale.split(/[-_]/)[0]).toLowerCase();
    addTrackedChart(db, bundleId, country, null, 'top-free');

    return jsonResponse({
      app: { id: app.id, bundleId: app.bundleId, primaryLocale: app.primaryLocale },
      liveVersion: versions[0] || null,
      editableVersion: editableVersions[0] || null,
      requestedLocale: locale,
      localeStatus: {
        versionLocaleExists,
        editableLocaleExists,
        appInfoLocaleExists,
        existingVersionLocales: allVersionLocales,
        existingEditableLocales: allEditableLocales,
        existingAppInfoLocales: allAppInfoLocales,
        note: (!versionLocaleExists || !appInfoLocaleExists)
          ? `Locale "${locale}" does not exist yet - you must create it before updating. Use asc_create_version_localization and/or asc_create_app_info_localization.`
          : `Locale "${locale}" exists and is ready for updates.`,
      },
      current: {
        name: appInfoMeta?.name || null,
        subtitle: appInfoMeta?.subtitle || null,
        keywords: versionMeta?.keywords || null,
        description: versionMeta?.description || null,
        whatsNew: versionMeta?.whatsNew || null,
        promotionalText: versionMeta?.promotionalText || null,
        supportUrl: versionMeta?.supportUrl || null,
        marketingUrl: versionMeta?.marketingUrl || null,
      },
      editable: editableMeta ? {
        keywords: editableMeta.keywords,
        description: editableMeta.description,
        whatsNew: editableMeta.whatsNew,
        promotionalText: editableMeta.promotionalText,
        supportUrl: editableMeta.supportUrl,
        marketingUrl: editableMeta.marketingUrl,
      } : null,
      localizationIds: {
        appInfo: appInfoMeta?.id || null,
        appInfoId: appInfos[0]?.id || null,
        liveVersion: versionMeta?.id || null,
        editableVersion: editableMeta?.id || null,
      },
    });
  }
);

// ============================================================================
// HISTORY & INTROSPECTION TOOLS
// ============================================================================

server.tool(
  'aso_db_stats',
  'Get overview of the local ASO history database - tracked apps, change counts, keyword counts.',
  {},
  async () => {
    const db = getDb();
    const dbPath = getDbPath();
    let dbSizeBytes = 0;
    try { dbSizeBytes = statSync(dbPath).size; } catch {}

    const appCount = db.prepare('SELECT COUNT(*) as c FROM apps').get().c;
    const changeCount = db.prepare('SELECT COUNT(*) as c FROM metadata_changes').get().c;
    const keywordCount = db.prepare('SELECT COUNT(*) as c FROM active_keywords').get().c;

    const earliestChange = db.prepare('SELECT MIN(changed_at) as v FROM metadata_changes').get().v;
    const latestChange = db.prepare('SELECT MAX(changed_at) as v FROM metadata_changes').get().v;

    const apps = db.prepare('SELECT bundle_id, name, added_at FROM apps ORDER BY added_at DESC').all()
      .map(a => ({ bundle_id: a.bundle_id, name: a.name, tracked_since: a.added_at }));

    return jsonResponse({
      db_path: dbPath,
      db_size_bytes: dbSizeBytes,
      schema_version: EXPECTED_SCHEMA_VERSION,
      counts: { apps: appCount, metadata_changes: changeCount, active_keywords: keywordCount },
      earliest_change_at: earliestChange,
      latest_change_at: latestChange,
      apps,
    });
  }
);

server.tool(
  'aso_get_change_history',
  'Get metadata change history for an app. Shows what was changed, when, and by whom.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    locale: z.string().optional().describe('Filter by locale (e.g. en-US)'),
    field: z.string().optional().describe('Filter by field (name, subtitle, keywords, description, whats_new, promotional_text)'),
    since_days: z.number().default(90).describe('How far back to look (default: 90 days)'),
    limit: z.number().default(50).describe('Max results (default: 50)'),
  },
  async ({ bundle_id, locale, field, since_days, limit }) => {
    const db = getDb();
    const sinceMs = Date.now() - since_days * 24 * 60 * 60 * 1000;

    if (locale) {
      const changes = getChangesFor(db, bundle_id, locale, { field, sinceMs, limit });
      return jsonResponse({ bundle_id, locale, since_days, changes });
    }

    let sql = 'SELECT * FROM metadata_changes WHERE bundle_id = ? AND changed_at >= ?';
    const params = [bundle_id, sinceMs];
    if (field) {
      sql += ' AND field = ?';
      params.push(field);
    }
    sql += ' ORDER BY changed_at DESC, id DESC LIMIT ?';
    params.push(limit);

    const changes = db.prepare(sql).all(...params);
    return jsonResponse({ bundle_id, since_days, changes });
  }
);

server.tool(
  'aso_get_active_keywords_with_age',
  'Get active keywords for an app+locale with age in days, last scores, and time since scored.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    locale: z.string().describe('Locale (e.g. en-US)'),
  },
  async ({ bundle_id, locale }) => {
    const db = getDb();
    const keywords = getActiveKeywords(db, bundle_id, locale);
    const now = Date.now();

    const enriched = keywords.map(k => ({
      keyword: k.keyword,
      days_since_added: Math.floor((now - k.added_at) / (1000 * 60 * 60 * 24)),
      days_since_scored: k.last_scored_at ? Math.floor((now - k.last_scored_at) / (1000 * 60 * 60 * 24)) : null,
      last_popularity: k.last_score_popularity,
      last_difficulty: k.last_score_difficulty,
      last_opportunity: k.last_score_opportunity,
      added_at: k.added_at,
      last_scored_at: k.last_scored_at,
    }));

    return jsonResponse({ bundle_id, locale, keyword_count: enriched.length, keywords: enriched });
  }
);

server.tool(
  'aso_get_keyword_score_history',
  'Get current tracked state and score time-series snapshots for a specific keyword.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    locale: z.string().describe('Locale'),
    keyword: z.string().describe('The keyword to look up'),
  },
  async ({ bundle_id, locale, keyword }) => {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM active_keywords WHERE bundle_id = ? AND locale = ? AND keyword = ?'
    ).get(bundle_id, locale, keyword);

    if (!row) return jsonResponse({ found: false, bundle_id, locale, keyword });

    const now = Date.now();
    const snapshots = getSnapshotHistory(db, keyword, locale, { limit: 30 });
    return jsonResponse({
      found: true,
      bundle_id, locale, keyword: row.keyword,
      days_since_added: Math.floor((now - row.added_at) / (1000 * 60 * 60 * 24)),
      days_since_scored: row.last_scored_at ? Math.floor((now - row.last_scored_at) / (1000 * 60 * 60 * 24)) : null,
      last_popularity: row.last_score_popularity,
      last_difficulty: row.last_score_difficulty,
      last_opportunity: row.last_score_opportunity,
      added_at: row.added_at,
      last_scored_at: row.last_scored_at,
      snapshots: snapshots.map(s => ({
        popularity: s.popularity, difficulty: s.difficulty, opportunity: s.opportunity, fetched_at: s.fetched_at,
      })),
    });
  }
);

// ============================================================================
// KEYWORD SNAPSHOT TOOLS (Phase 5)
// ============================================================================

server.tool(
  'aso_snapshot_keywords',
  'Score keywords and persist snapshots for time-series tracking. Calls score_keywords_batch internally.',
  {
    keywords: z.array(z.string()).describe('Keywords to score and snapshot (max 15)'),
    country: z.string().default('us').describe('ISO country code'),
  },
  async ({ keywords: kwList, country }) => {
    const results = [];
    const batch = kwList.slice(0, 15);
    const db = getDb();

    for (const kw of batch) {
      try {
        const result = await scoreKeyword(kw, country);
        results.push(result);
        appendSnapshot(db, {
          keyword: kw, locale: country,
          popularity: result.popularity, difficulty: result.difficulty, opportunity: result.opportunity,
          rawJson: JSON.stringify(result),
        });
      } catch (e) {
        results.push({ keyword: kw, error: e.message });
      }
      if (batch.indexOf(kw) < batch.length - 1) await sleep(DELAY_MS);
    }

    return jsonResponse({ snapshotted: results.filter(r => !r.error).length, errors: results.filter(r => r.error).length, results });
  }
);

server.tool(
  'aso_keyword_trend',
  'Get score time-series for a keyword. Shows how popularity/difficulty/opportunity changed over time.',
  {
    keyword: z.string().describe('Keyword to get trend for'),
    locale: z.string().default('us').describe('Locale/country'),
    days: z.number().default(30).describe('How many days back (default: 30)'),
  },
  async ({ keyword, locale, days }) => {
    const db = getDb();
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const snapshots = getSnapshotHistory(db, keyword, locale, { sinceMs });

    return jsonResponse({
      keyword, locale, days,
      data_points: snapshots.length,
      snapshots: snapshots.reverse().map(s => ({
        popularity: s.popularity, difficulty: s.difficulty, opportunity: s.opportunity, fetched_at: s.fetched_at,
      })),
    });
  }
);

// ============================================================================
// RANK TRACKING TOOLS (Phase 6)
// ============================================================================

server.tool(
  'aso_track_keyword',
  'Add a keyword to rank tracking. Immediately fetches initial rank from iTunes Search.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    keyword: z.string().describe('Keyword to track'),
    locale: z.string().describe('Locale (e.g. en-US, de-DE)'),
  },
  async ({ bundle_id, keyword, locale }) => {
    const db = getDb();
    const added = addTrackedKeyword(db, bundle_id, keyword, locale);
    if (!added) return jsonResponse({ added: false, reason: 'already_tracked' });

    try {
      const { rank, totalResults } = await fetchRank(bundle_id, keyword, locale);
      recordRank(db, { bundleId: bundle_id, keyword, locale, rank, totalResults });
      return jsonResponse({ added: true, initial_rank: rank, total_results: totalResults });
    } catch (e) {
      return jsonResponse({ added: true, initial_rank: null, error: e.message });
    }
  }
);

server.tool(
  'aso_track_active_keywords',
  'Bulk-add all active keywords for an app+locale to rank tracking.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    locale: z.string().describe('Locale'),
  },
  async ({ bundle_id, locale }) => {
    const db = getDb();
    const active = getActiveKeywords(db, bundle_id, locale);
    let added = 0;
    for (const kw of active) {
      if (addTrackedKeyword(db, bundle_id, kw.keyword, locale)) added++;
    }
    return jsonResponse({ total_active: active.length, newly_tracked: added });
  }
);

server.tool(
  'aso_untrack_keyword',
  'Remove a keyword from rank tracking. Historical rank data is preserved.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    keyword: z.string().describe('Keyword to untrack'),
    locale: z.string().describe('Locale'),
  },
  async ({ bundle_id, keyword, locale }) => {
    const db = getDb();
    removeTrackedKeyword(db, bundle_id, keyword, locale);
    return jsonResponse({ removed: true });
  }
);

server.tool(
  'aso_refresh_ranks',
  'Fetch current ranks for all tracked keywords. Skips keywords tracked recently (within stale_hours).',
  {
    bundle_id: z.string().optional().describe('App bundle ID (all apps if omitted)'),
    locale: z.string().optional().describe('Filter by locale'),
    stale_hours: z.number().default(20).describe('Only refresh keywords not tracked in last N hours (default: 20)'),
  },
  async ({ bundle_id, locale, stale_hours }) => {
    const db = getDb();
    const staleCutoff = Date.now() - stale_hours * 60 * 60 * 1000;
    let refreshed = 0, skippedFresh = 0, errors = 0;

    const apps = bundle_id ? [{ bundle_id }] : listApps(db).map(a => ({ bundle_id: a.bundle_id }));

    for (const app of apps) {
      const tracked = listTrackedKeywords(db, app.bundle_id, locale);
      for (const tk of tracked) {
        if (tk.last_tracked_at && tk.last_tracked_at > staleCutoff) {
          skippedFresh++;
          continue;
        }
        try {
          const { rank, totalResults } = await fetchRank(app.bundle_id, tk.keyword, tk.locale);
          recordRank(db, { bundleId: app.bundle_id, keyword: tk.keyword, locale: tk.locale, rank, totalResults });
          refreshed++;
        } catch {
          errors++;
        }
        await sleep(DELAY_MS);
      }
    }

    return jsonResponse({ refreshed, skipped_fresh: skippedFresh, errors });
  }
);

server.tool(
  'aso_get_rank_history',
  'Get rank time-series for a keyword. Shows how the app ranked over time in iTunes Search.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    keyword: z.string().describe('Keyword'),
    locale: z.string().describe('Locale'),
    days: z.number().default(30).describe('How many days back (default: 30)'),
  },
  async ({ bundle_id, keyword, locale, days }) => {
    const db = getDb();
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const history = getRankHistory(db, bundle_id, keyword, locale, { sinceMs });

    return jsonResponse({
      bundle_id, keyword, locale, days,
      data_points: history.length,
      history: history.reverse().map(r => ({ rank: r.rank, total_results: r.total_results, fetched_at: r.fetched_at })),
    });
  }
);

server.tool(
  'aso_get_rank_movements',
  'Detect meaningful rank movements for tracked keywords. Filters noise and classifies changes.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    locale: z.string().optional().describe('Filter by locale'),
    since_days: z.number().default(14).describe('Window in days (default: 14)'),
    min_movement: z.number().default(5).describe('Minimum positions to count as movement (default: 5)'),
  },
  async ({ bundle_id, locale, since_days, min_movement }) => {
    const db = getDb();
    const movements = getRankMovements(db, bundle_id, locale, { sinceDays: since_days, minMovement: min_movement });
    return jsonResponse({ bundle_id, locale, since_days, min_movement, movements });
  }
);

// ============================================================================
// CATEGORY CHART TOOLS (Phase 7)
// ============================================================================

server.tool(
  'aso_track_chart',
  'Start tracking app position in a category chart. Immediately fetches initial rank.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    country: z.string().describe('Two-letter country code (us, pl, de, etc.)'),
    genre_id: z.number().optional().describe('Genre ID (null for overall chart). E.g. 6014=Games, 6007=Productivity'),
    chart_type: z.string().default('top-free').describe('Chart type: top-free, top-paid, or top-grossing'),
  },
  async ({ bundle_id, country, genre_id, chart_type }) => {
    const db = getDb();
    const added = addTrackedChart(db, bundle_id, country, genre_id ?? null, chart_type);
    if (!added) return jsonResponse({ added: false, reason: 'already_tracked' });

    try {
      const { rank, totalResults } = await fetchCategoryRank(bundle_id, country, genre_id ?? null, chart_type);
      recordCategoryRank(db, { bundleId: bundle_id, country, genreId: genre_id ?? null, chartType: chart_type, rank });
      const label = genre_id ? genreName(genre_id) : 'Overall';
      return jsonResponse({ added: true, initial_rank: rank, chart: `${label} ${chart_type} ${country.toUpperCase()}` });
    } catch (e) {
      return jsonResponse({ added: true, initial_rank: null, error: e.message });
    }
  }
);

server.tool(
  'aso_track_app_categories',
  'Bulk-add chart tracking for an app across multiple countries. Tracks overall + primary genre top-free and top-grossing.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    countries: z.array(z.string()).describe('Country codes (e.g. ["us", "de", "pl"])'),
    genre_id: z.number().optional().describe('Primary genre ID (e.g. 6014 for Games). If omitted, only tracks overall charts.'),
    include_grossing: z.boolean().default(false).describe('Also track top-grossing charts'),
  },
  async ({ bundle_id, countries, genre_id, include_grossing }) => {
    const db = getDb();
    const added = [];

    for (const country of countries) {
      const charts = [{ genreId: null, chartType: 'top-free' }];
      if (genre_id) charts.push({ genreId: genre_id, chartType: 'top-free' });
      if (include_grossing) {
        charts.push({ genreId: null, chartType: 'top-grossing' });
        if (genre_id) charts.push({ genreId: genre_id, chartType: 'top-grossing' });
      }
      for (const { genreId: gid, chartType } of charts) {
        if (addTrackedChart(db, bundle_id, country, gid, chartType)) {
          const label = gid ? genreName(gid) : 'Overall';
          added.push(`${label} ${chartType} ${country.toUpperCase()}`);
        }
      }
    }

    return jsonResponse({ charts_added: added.length, charts: added });
  }
);

server.tool(
  'aso_refresh_category_ranks',
  'Fetch current chart positions for all tracked charts. Skips charts tracked recently.',
  {
    bundle_id: z.string().optional().describe('App bundle ID (all apps if omitted)'),
    stale_hours: z.number().default(20).describe('Only refresh charts not tracked in last N hours (default: 20)'),
  },
  async ({ bundle_id, stale_hours }) => {
    const db = getDb();
    const staleCutoff = Date.now() - stale_hours * 60 * 60 * 1000;
    let refreshed = 0, skippedFresh = 0, errors = 0;

    const charts = listTrackedCharts(db, bundle_id || undefined);

    for (const chart of charts) {
      if (chart.last_tracked_at && chart.last_tracked_at > staleCutoff) {
        skippedFresh++;
        continue;
      }
      try {
        const { rank } = await fetchCategoryRank(chart.bundle_id, chart.country, chart.genre_id, chart.chart_type);
        recordCategoryRank(db, { bundleId: chart.bundle_id, country: chart.country, genreId: chart.genre_id, chartType: chart.chart_type, rank });
        refreshed++;
      } catch {
        errors++;
      }
      await sleep(DELAY_MS);
    }

    return jsonResponse({ refreshed, skipped_fresh: skippedFresh, errors });
  }
);

server.tool(
  'aso_get_category_rank_history',
  'Get chart position time-series for an app in a specific chart.',
  {
    bundle_id: z.string().describe('App bundle ID'),
    country: z.string().describe('Country code'),
    genre_id: z.number().optional().describe('Genre ID (omit for overall chart)'),
    chart_type: z.string().default('top-free').describe('Chart type'),
    days: z.number().default(30).describe('How many days back (default: 30)'),
  },
  async ({ bundle_id, country, genre_id, chart_type, days }) => {
    const db = getDb();
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const history = getCategoryRankHistory(db, bundle_id, country, genre_id ?? null, chart_type, { sinceMs });
    const label = genre_id ? genreName(genre_id) : 'Overall';

    return jsonResponse({
      bundle_id, country, chart: `${label} ${chart_type}`, days,
      data_points: history.length,
      history: history.reverse().map(r => ({ rank: r.rank, fetched_at: r.fetched_at })),
    });
  }
);

server.tool(
  'aso_get_category_movements',
  'Detect meaningful chart position movements. Uses stricter thresholds than keyword rank (default min 3 positions).',
  {
    bundle_id: z.string().optional().describe('App bundle ID (all apps if omitted)'),
    since_days: z.number().default(14).describe('Window in days (default: 14)'),
  },
  async ({ bundle_id, since_days }) => {
    const db = getDb();
    const movements = getCategoryMovements(db, bundle_id || undefined, { sinceDays: since_days });

    const enriched = movements.map(m => ({
      ...m,
      genre_name: m.genre_id ? genreName(m.genre_id) : 'Overall',
    }));

    return jsonResponse({ bundle_id, since_days, movements: enriched });
  }
);

server.tool(
  'aso_category_snapshot',
  'One-shot read of current position across all tracked charts for an app.',
  {
    bundle_id: z.string().describe('App bundle ID'),
  },
  async ({ bundle_id }) => {
    const db = getDb();
    const charts = listTrackedCharts(db, bundle_id);

    const positions = charts.map(chart => {
      const latest = getLatestCategoryRank(db, chart.bundle_id, chart.country, chart.genre_id, chart.chart_type);
      return {
        country: chart.country,
        genre_id: chart.genre_id,
        genre_name: chart.genre_id ? genreName(chart.genre_id) : 'Overall',
        chart_type: chart.chart_type,
        rank: latest?.rank ?? null,
        last_tracked_at: latest?.fetched_at ?? null,
      };
    });

    return jsonResponse({ bundle_id, charts_tracked: positions.length, positions });
  }
);

// -- Start ------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
