import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from '../lib/db.js';
import { initSchema } from '../lib/schema.js';
import { upsertApp, getApp, listApps } from '../lib/repos/apps.js';
import { logChange, getChangesFor, getLastChange } from '../lib/repos/metadataChanges.js';
import {
  setActiveKeywords, getActiveKeywords, updateKeywordScore, getKeywordAge,
} from '../lib/repos/activeKeywords.js';
import { appendSnapshot, getHistory } from '../lib/repos/keywordSnapshots.js';
import {
  addTrackedKeyword, removeTrackedKeyword, listTrackedKeywords,
  recordRank, getRankHistory, getLatestRank, getRankMovements,
} from '../lib/repos/ranks.js';
import {
  addTrackedChart, removeTrackedChart, listTrackedCharts,
  recordCategoryRank, getCategoryRankHistory, getLatestCategoryRank, getCategoryMovements,
} from '../lib/repos/categoryRanks.js';

function freshDb() {
  const db = createMemoryDb();
  initSchema(db);
  return db;
}

// -- apps repo ----------------------------------------------------------------

describe('apps repo', () => {
  let db;
  beforeEach(() => { db = freshDb(); });

  it('inserts and retrieves an app', () => {
    upsertApp(db, 'com.test.app', { name: 'Test App' });
    const app = getApp(db, 'com.test.app');
    assert.equal(app.bundle_id, 'com.test.app');
    assert.equal(app.name, 'Test App');
    assert.ok(app.added_at > 0);
  });

  it('upserts without overwriting added_at', () => {
    upsertApp(db, 'com.test.app', { name: 'V1' });
    const first = getApp(db, 'com.test.app');
    upsertApp(db, 'com.test.app', { name: 'V2' });
    const second = getApp(db, 'com.test.app');
    assert.equal(second.name, 'V2');
    assert.equal(second.added_at, first.added_at);
  });

  it('returns null for missing app', () => {
    assert.equal(getApp(db, 'com.nope'), null);
  });

  it('lists apps', () => {
    upsertApp(db, 'com.a', { name: 'A' });
    upsertApp(db, 'com.b', { name: 'B' });
    assert.equal(listApps(db).length, 2);
  });
});

// -- metadataChanges repo -----------------------------------------------------

describe('metadataChanges repo', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    upsertApp(db, 'com.test.app', { name: 'Test' });
  });

  it('logs and retrieves a change', () => {
    logChange(db, {
      bundleId: 'com.test.app', locale: 'en-US', field: 'keywords',
      oldValue: 'old', newValue: 'new', source: 'aso-optimize',
    });
    const changes = getChangesFor(db, 'com.test.app', 'en-US');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].field, 'keywords');
    assert.equal(changes[0].source, 'aso-optimize');
  });

  it('filters by field', () => {
    logChange(db, { bundleId: 'com.test.app', locale: 'en-US', field: 'keywords', oldValue: 'a', newValue: 'b' });
    logChange(db, { bundleId: 'com.test.app', locale: 'en-US', field: 'name', oldValue: 'x', newValue: 'y' });
    const kw = getChangesFor(db, 'com.test.app', 'en-US', { field: 'keywords' });
    assert.equal(kw.length, 1);
  });

  it('getLastChange returns most recent', () => {
    logChange(db, { bundleId: 'com.test.app', locale: 'en-US', field: 'keywords', oldValue: 'a', newValue: 'b' });
    logChange(db, { bundleId: 'com.test.app', locale: 'en-US', field: 'keywords', oldValue: 'b', newValue: 'c' });
    const last = getLastChange(db, 'com.test.app', 'en-US', 'keywords');
    assert.equal(last.new_value, 'c');
  });

  it('getLastChange returns null when no changes', () => {
    assert.equal(getLastChange(db, 'com.test.app', 'en-US', 'keywords'), null);
  });

  it('respects sinceMs filter', () => {
    logChange(db, { bundleId: 'com.test.app', locale: 'en-US', field: 'keywords', oldValue: 'a', newValue: 'b' });
    const future = Date.now() + 100000;
    const changes = getChangesFor(db, 'com.test.app', 'en-US', { sinceMs: future });
    assert.equal(changes.length, 0);
  });
});

// -- activeKeywords repo ------------------------------------------------------

describe('activeKeywords repo', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    upsertApp(db, 'com.test.app', { name: 'Test' });
  });

  it('sets and gets active keywords', () => {
    setActiveKeywords(db, 'com.test.app', 'en-US', ['puzzle', 'game', 'logic']);
    const kws = getActiveKeywords(db, 'com.test.app', 'en-US');
    assert.equal(kws.length, 3);
    assert.deepEqual(kws.map(k => k.keyword), ['game', 'logic', 'puzzle']);
  });

  it('preserves existing keywords on re-set', () => {
    setActiveKeywords(db, 'com.test.app', 'en-US', ['puzzle', 'game']);
    const first = getActiveKeywords(db, 'com.test.app', 'en-US');
    const puzzleAddedAt = first.find(k => k.keyword === 'puzzle').added_at;

    setActiveKeywords(db, 'com.test.app', 'en-US', ['puzzle', 'logic']);
    const second = getActiveKeywords(db, 'com.test.app', 'en-US');
    assert.equal(second.length, 2);
    assert.deepEqual(second.map(k => k.keyword), ['logic', 'puzzle']);
    assert.equal(second.find(k => k.keyword === 'puzzle').added_at, puzzleAddedAt);
  });

  it('removes keywords no longer present', () => {
    setActiveKeywords(db, 'com.test.app', 'en-US', ['a', 'b', 'c']);
    setActiveKeywords(db, 'com.test.app', 'en-US', ['b']);
    assert.equal(getActiveKeywords(db, 'com.test.app', 'en-US').length, 1);
  });

  it('updates keyword score', () => {
    setActiveKeywords(db, 'com.test.app', 'en-US', ['puzzle']);
    updateKeywordScore(db, 'com.test.app', 'en-US', 'puzzle', {
      popularity: 65, difficulty: 30, opportunity: 45,
    });
    const kws = getActiveKeywords(db, 'com.test.app', 'en-US');
    assert.equal(kws[0].last_score_popularity, 65);
    assert.equal(kws[0].last_score_difficulty, 30);
    assert.equal(kws[0].last_score_opportunity, 45);
    assert.ok(kws[0].last_scored_at > 0);
  });

  it('getKeywordAge returns days', () => {
    setActiveKeywords(db, 'com.test.app', 'en-US', ['puzzle']);
    const age = getKeywordAge(db, 'com.test.app', 'en-US', 'puzzle');
    assert.equal(age, 0);
  });

  it('getKeywordAge returns null for unknown keyword', () => {
    assert.equal(getKeywordAge(db, 'com.test.app', 'en-US', 'nope'), null);
  });

  it('handles empty keyword list', () => {
    setActiveKeywords(db, 'com.test.app', 'en-US', ['a', 'b']);
    setActiveKeywords(db, 'com.test.app', 'en-US', []);
    assert.equal(getActiveKeywords(db, 'com.test.app', 'en-US').length, 0);
  });
});

// -- keywordSnapshots repo ----------------------------------------------------

describe('keywordSnapshots repo', () => {
  let db;
  beforeEach(() => { db = freshDb(); });

  it('appends and retrieves snapshots', () => {
    appendSnapshot(db, { keyword: 'puzzle', locale: 'us', popularity: 65, difficulty: 30, opportunity: 45 });
    appendSnapshot(db, { keyword: 'puzzle', locale: 'us', popularity: 67, difficulty: 28, opportunity: 48 });
    const history = getHistory(db, 'puzzle', 'us');
    assert.equal(history.length, 2);
    assert.equal(history[0].popularity, 67);
  });

  it('filters by sinceMs', () => {
    appendSnapshot(db, { keyword: 'puzzle', locale: 'us', popularity: 65, difficulty: 30, opportunity: 45 });
    const future = Date.now() + 100000;
    assert.equal(getHistory(db, 'puzzle', 'us', { sinceMs: future }).length, 0);
  });

  it('stores raw_json', () => {
    appendSnapshot(db, { keyword: 'test', locale: 'us', popularity: 50, difficulty: 50, opportunity: 25, rawJson: '{"foo":1}' });
    const h = getHistory(db, 'test', 'us');
    assert.equal(h[0].raw_json, '{"foo":1}');
  });
});

// -- ranks repo ---------------------------------------------------------------

describe('ranks repo', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    upsertApp(db, 'com.test.app', { name: 'Test' });
  });

  it('adds and lists tracked keywords', () => {
    const added = addTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    assert.equal(added, true);
    const again = addTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    assert.equal(again, false);
    assert.equal(listTrackedKeywords(db, 'com.test.app').length, 1);
  });

  it('removes tracked keyword', () => {
    addTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    removeTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    assert.equal(listTrackedKeywords(db, 'com.test.app').length, 0);
  });

  it('records and retrieves rank', () => {
    addTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 42, totalResults: 200 });
    const latest = getLatestRank(db, 'com.test.app', 'puzzle', 'us');
    assert.equal(latest.rank, 42);
    assert.equal(latest.total_results, 200);
  });

  it('returns rank history', () => {
    addTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 50, totalResults: 200 });
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 42, totalResults: 200 });
    const history = getRankHistory(db, 'com.test.app', 'puzzle', 'us');
    assert.equal(history.length, 2);
  });

  it('detects climbing movement', () => {
    addTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 50, totalResults: 200 });
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 40, totalResults: 200 });
    const moves = getRankMovements(db, 'com.test.app', 'us');
    assert.equal(moves.length, 1);
    assert.equal(moves[0].classification, 'climbing');
  });

  it('ignores small movements as noise', () => {
    addTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 42, totalResults: 200 });
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 40, totalResults: 200 });
    const moves = getRankMovements(db, 'com.test.app', 'us');
    assert.equal(moves.length, 0);
  });

  it('detects dropped_out_of_ranking', () => {
    addTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 42, totalResults: 200 });
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: null, totalResults: 200 });
    const moves = getRankMovements(db, 'com.test.app', 'us');
    assert.equal(moves.length, 1);
    assert.equal(moves[0].classification, 'dropped_out_of_ranking');
  });

  it('applies percentage threshold for deep ranks', () => {
    addTrackedKeyword(db, 'com.test.app', 'puzzle', 'us');
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 80, totalResults: 200 });
    recordRank(db, { bundleId: 'com.test.app', keyword: 'puzzle', locale: 'us', rank: 85, totalResults: 200 });
    const moves = getRankMovements(db, 'com.test.app', 'us');
    assert.equal(moves.length, 0);
  });
});

// -- categoryRanks repo -------------------------------------------------------

describe('categoryRanks repo', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
    upsertApp(db, 'com.test.app', { name: 'Test' });
  });

  it('adds and lists tracked charts', () => {
    addTrackedChart(db, 'com.test.app', 'us', null, 'top-free');
    addTrackedChart(db, 'com.test.app', 'us', 6014, 'top-free');
    assert.equal(listTrackedCharts(db, 'com.test.app').length, 2);
  });

  it('removes tracked chart', () => {
    addTrackedChart(db, 'com.test.app', 'us', null, 'top-free');
    removeTrackedChart(db, 'com.test.app', 'us', null, 'top-free');
    assert.equal(listTrackedCharts(db, 'com.test.app').length, 0);
  });

  it('records and retrieves category rank', () => {
    addTrackedChart(db, 'com.test.app', 'us', 6014, 'top-free');
    recordCategoryRank(db, { bundleId: 'com.test.app', country: 'us', genreId: 6014, chartType: 'top-free', rank: 15 });
    const latest = getLatestCategoryRank(db, 'com.test.app', 'us', 6014, 'top-free');
    assert.equal(latest.rank, 15);
  });

  it('returns category rank history', () => {
    addTrackedChart(db, 'com.test.app', 'us', null, 'top-free');
    recordCategoryRank(db, { bundleId: 'com.test.app', country: 'us', genreId: null, chartType: 'top-free', rank: 20 });
    recordCategoryRank(db, { bundleId: 'com.test.app', country: 'us', genreId: null, chartType: 'top-free', rank: 15 });
    const history = getCategoryRankHistory(db, 'com.test.app', 'us', null, 'top-free');
    assert.equal(history.length, 2);
  });

  it('detects category climbing movement', () => {
    addTrackedChart(db, 'com.test.app', 'us', null, 'top-free');
    recordCategoryRank(db, { bundleId: 'com.test.app', country: 'us', genreId: null, chartType: 'top-free', rank: 20 });
    recordCategoryRank(db, { bundleId: 'com.test.app', country: 'us', genreId: null, chartType: 'top-free', rank: 10 });
    const moves = getCategoryMovements(db, 'com.test.app');
    assert.ok(moves.length >= 1);
    const m = moves.find(m => m.classification === 'entered_top_10');
    assert.ok(m);
  });

  it('ignores small category movements', () => {
    addTrackedChart(db, 'com.test.app', 'us', null, 'top-free');
    recordCategoryRank(db, { bundleId: 'com.test.app', country: 'us', genreId: null, chartType: 'top-free', rank: 45 });
    recordCategoryRank(db, { bundleId: 'com.test.app', country: 'us', genreId: null, chartType: 'top-free', rank: 44 });
    const moves = getCategoryMovements(db, 'com.test.app');
    assert.equal(moves.length, 0);
  });
});
