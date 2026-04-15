// mcp-server.js
// Unified ASO analysis + App Store Connect MCP server
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { computePopularity, computeDifficulty, classify, difficultyLabel } from './scoring.js';
import { AppStoreConnectClient } from './appstore-connect.js';

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
  async ({ keyword, country }) => jsonResponse(await scoreKeyword(keyword, country))
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

    // Parse included resources for a quick overview
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
  },
  async ({ localizationId, keywords, description, whatsNew, promotionalText, supportUrl, marketingUrl }) => {
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
    const result = await client.updateVersionLocalization(localizationId, attrs);
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
  },
  async ({ localizationId, name, subtitle }) => {
    const attrs = {};
    if (name !== undefined) attrs.name = name;
    if (subtitle !== undefined) attrs.subtitle = subtitle;

    if (Object.keys(attrs).length === 0) {
      return jsonResponse({ error: 'No attributes provided to update' });
    }

    const client = getASCClient();
    const result = await client.updateAppInfoLocalization(localizationId, attrs);
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

    // Step 1: Find the app
    const app = await client.lookupAppByBundleId(bundleId);

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

// -- Start ------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
