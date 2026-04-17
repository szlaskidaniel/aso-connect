#!/usr/bin/env node
import { getDb } from '../lib/db.js';
import { initSchema } from '../lib/schema.js';
import { listApps } from '../lib/repos/apps.js';
import { getActiveKeywords } from '../lib/repos/activeKeywords.js';
import { addTrackedKeyword, listTrackedKeywords, recordRank } from '../lib/repos/ranks.js';
import { addTrackedChart, listTrackedCharts, recordCategoryRank } from '../lib/repos/categoryRanks.js';
import { fetchRank } from '../lib/rankFetcher.js';
import { fetchCategoryRank } from '../lib/categoryFetcher.js';

const DELAY_MS = 1000;
const STALE_HOURS = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const db = getDb();
initSchema(db);

const staleCutoff = Date.now() - STALE_HOURS * 60 * 60 * 1000;
const apps = listApps(db);

console.log(`Found ${apps.length} tracked app(s)`);

// Auto-promote active keywords to tracked keywords
let autoTracked = 0;
for (const app of apps) {
  const locales = db.prepare(
    'SELECT DISTINCT locale FROM active_keywords WHERE bundle_id = ?'
  ).all(app.bundle_id);

  for (const { locale } of locales) {
    const active = getActiveKeywords(db, app.bundle_id, locale);
    for (const kw of active) {
      if (addTrackedKeyword(db, app.bundle_id, kw.keyword, locale)) autoTracked++;
    }
  }
}
if (autoTracked > 0) console.log(`Auto-tracked ${autoTracked} active keyword(s)`);

// Auto-track overall top-free chart for each country derived from active keyword locales
let chartsAdded = 0;
for (const app of apps) {
  const locales = db.prepare(
    'SELECT DISTINCT locale FROM active_keywords WHERE bundle_id = ?'
  ).all(app.bundle_id);

  for (const { locale } of locales) {
    const country = locale.length === 2 ? locale.toLowerCase() : (locale.split(/[-_]/)[1] || locale.split(/[-_]/)[0]).toLowerCase();
    if (addTrackedChart(db, app.bundle_id, country, null, 'top-free')) chartsAdded++;
  }
}
if (chartsAdded > 0) console.log(`Auto-tracked ${chartsAdded} category chart(s)`);

let kwRefreshed = 0, kwSkipped = 0, kwErrors = 0;

for (const app of apps) {
  const tracked = listTrackedKeywords(db, app.bundle_id);
  for (const tk of tracked) {
    if (tk.last_tracked_at && tk.last_tracked_at > staleCutoff) {
      kwSkipped++;
      continue;
    }
    try {
      const { rank, totalResults } = await fetchRank(app.bundle_id, tk.keyword, tk.locale);
      recordRank(db, { bundleId: app.bundle_id, keyword: tk.keyword, locale: tk.locale, rank, totalResults });
      kwRefreshed++;
      process.stdout.write('.');
    } catch {
      kwErrors++;
      process.stdout.write('x');
    }
    await sleep(DELAY_MS);
  }
}

console.log(`\nKeyword ranks: ${kwRefreshed} refreshed, ${kwSkipped} skipped (fresh), ${kwErrors} errors`);

let catRefreshed = 0, catSkipped = 0, catErrors = 0;

const charts = listTrackedCharts(db);
for (const chart of charts) {
  if (chart.last_tracked_at && chart.last_tracked_at > staleCutoff) {
    catSkipped++;
    continue;
  }
  try {
    const { rank } = await fetchCategoryRank(chart.bundle_id, chart.country, chart.genre_id, chart.chart_type);
    recordCategoryRank(db, { bundleId: chart.bundle_id, country: chart.country, genreId: chart.genre_id, chartType: chart.chart_type, rank });
    catRefreshed++;
    process.stdout.write('.');
  } catch {
    catErrors++;
    process.stdout.write('x');
  }
  await sleep(DELAY_MS);
}

console.log(`\nCategory ranks: ${catRefreshed} refreshed, ${catSkipped} skipped (fresh), ${catErrors} errors`);

db.close();
console.log('Done.');
