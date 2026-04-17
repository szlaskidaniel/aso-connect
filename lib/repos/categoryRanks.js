export function addTrackedChart(db, bundleId, country, genreId, chartType) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO tracked_charts (bundle_id, country, genre_id, chart_type, added_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(bundleId, country, genreId ?? null, chartType, Date.now());
  return result.changes > 0;
}

export function removeTrackedChart(db, bundleId, country, genreId, chartType) {
  db.prepare(
    'DELETE FROM tracked_charts WHERE bundle_id = ? AND country = ? AND genre_id IS ? AND chart_type = ?'
  ).run(bundleId, country, genreId ?? null, chartType);
}

export function listTrackedCharts(db, bundleId) {
  let sql = 'SELECT * FROM tracked_charts';
  const params = [];
  if (bundleId) {
    sql += ' WHERE bundle_id = ?';
    params.push(bundleId);
  }
  sql += ' ORDER BY bundle_id, country, chart_type';
  return db.prepare(sql).all(...params);
}

export function recordCategoryRank(db, { bundleId, country, genreId, chartType, rank }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO category_ranks (bundle_id, country, genre_id, chart_type, rank, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bundleId, country, genreId ?? null, chartType, rank ?? null, now);

  db.prepare(`
    UPDATE tracked_charts SET last_tracked_at = ?
    WHERE bundle_id = ? AND country = ? AND genre_id IS ? AND chart_type = ?
  `).run(now, bundleId, country, genreId ?? null, chartType);
}

export function getCategoryRankHistory(db, bundleId, country, genreId, chartType, { sinceMs, limit = 100 } = {}) {
  let sql = 'SELECT * FROM category_ranks WHERE bundle_id = ? AND country = ? AND genre_id IS ? AND chart_type = ?';
  const params = [bundleId, country, genreId ?? null, chartType];

  if (sinceMs) {
    sql += ' AND fetched_at >= ?';
    params.push(sinceMs);
  }

  sql += ' ORDER BY fetched_at DESC, id DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

export function getLatestCategoryRank(db, bundleId, country, genreId, chartType) {
  return db.prepare(`
    SELECT * FROM category_ranks
    WHERE bundle_id = ? AND country = ? AND genre_id IS ? AND chart_type = ?
    ORDER BY fetched_at DESC, id DESC LIMIT 1
  `).get(bundleId, country, genreId ?? null, chartType) || null;
}

export function getCategoryMovements(db, bundleId, { sinceDays = 14, minMovement = 3 } = {}) {
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  let chartSql = 'SELECT * FROM tracked_charts';
  const chartParams = [];
  if (bundleId) {
    chartSql += ' WHERE bundle_id = ?';
    chartParams.push(bundleId);
  }
  const charts = db.prepare(chartSql).all(...chartParams);

  const movements = [];

  for (const chart of charts) {
    const ranks = db.prepare(`
      SELECT rank, fetched_at FROM category_ranks
      WHERE bundle_id = ? AND country = ? AND genre_id IS ? AND chart_type = ? AND fetched_at >= ?
      ORDER BY fetched_at ASC, id ASC
    `).all(chart.bundle_id, chart.country, chart.genre_id, chart.chart_type, sinceMs);

    if (ranks.length < 2) continue;

    const oldest = ranks[0];
    const newest = ranks[ranks.length - 1];
    const oldRank = oldest.rank;
    const newRank = newest.rank;

    const classification = classifyCategoryMovement(oldRank, newRank, minMovement);
    if (!classification) continue;

    movements.push({
      bundle_id: chart.bundle_id,
      country: chart.country,
      genre_id: chart.genre_id,
      chart_type: chart.chart_type,
      old_rank: oldRank,
      new_rank: newRank,
      delta: oldRank != null && newRank != null ? oldRank - newRank : null,
      classification,
      time_window_days: sinceDays,
    });
  }

  return movements;
}

function classifyCategoryMovement(oldRank, newRank, minMovement) {
  if (oldRank != null && newRank == null) return 'dropped_out_of_chart';
  if (oldRank == null && newRank != null) return 'newly_charted';

  if (oldRank == null && newRank == null) return null;

  const delta = oldRank - newRank;
  const absDelta = Math.abs(delta);

  if (oldRank > 10 && newRank <= 10) return 'entered_top_10';
  if (oldRank <= 10 && newRank > 10) return 'dropped_from_top_10';
  if (oldRank > 50 && newRank <= 50) return 'entered_top_50';
  if (oldRank <= 50 && newRank > 50) return 'dropped_from_top_50';
  if (oldRank > 100 && newRank <= 100) return 'entered_top_100';
  if (oldRank <= 100 && newRank > 100) return 'dropped_from_top_100';

  if (absDelta < minMovement) return null;

  return delta > 0 ? 'climbing' : 'falling';
}
