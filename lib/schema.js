const EXPECTED_SCHEMA_VERSION = 2;

export function initSchema(db) {
  db.exec(`
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

    -- Phase 5: keyword snapshots (time-series)
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

    -- Phase 6: rank tracking
    CREATE TABLE IF NOT EXISTS keyword_ranks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      locale TEXT NOT NULL,
      rank INTEGER,
      total_results INTEGER,
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

    -- Phase 7: category chart tracking
    CREATE TABLE IF NOT EXISTS category_ranks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_id TEXT NOT NULL,
      country TEXT NOT NULL,
      genre_id INTEGER,
      chart_type TEXT NOT NULL,
      rank INTEGER,
      fetched_at INTEGER NOT NULL,
      FOREIGN KEY (bundle_id) REFERENCES apps(bundle_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cat_ranks_app
      ON category_ranks(bundle_id, country, genre_id, chart_type, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS tracked_charts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_id TEXT NOT NULL,
      country TEXT NOT NULL,
      genre_id INTEGER,
      chart_type TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      last_tracked_at INTEGER,
      FOREIGN KEY (bundle_id) REFERENCES apps(bundle_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_charts_unique
      ON tracked_charts(bundle_id, country, COALESCE(genre_id, -1), chart_type);
  `);

  const row = db.prepare('SELECT value FROM _meta WHERE key = ?').get('schema_version');

  if (!row) {
    db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run('schema_version', String(EXPECTED_SCHEMA_VERSION));
    return;
  }

  const found = parseInt(row.value, 10);
  if (found < EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `ASO Connect: DB schema outdated (found v${found}, expected v${EXPECTED_SCHEMA_VERSION}). ` +
      'Delete .aso-connect/aso.db to reinitialize. History will be lost.'
    );
  }
}

export { EXPECTED_SCHEMA_VERSION };
