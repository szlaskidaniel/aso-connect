export function addTrackedKeyword(db, bundleId, keyword, locale) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO tracked_keywords (bundle_id, keyword, locale, added_at)
    VALUES (?, ?, ?, ?)
  `).run(bundleId, keyword, locale, Date.now());
  return result.changes > 0;
}

export function removeTrackedKeyword(db, bundleId, keyword, locale) {
  db.prepare(
    'DELETE FROM tracked_keywords WHERE bundle_id = ? AND keyword = ? AND locale = ?'
  ).run(bundleId, keyword, locale);
}

export function listTrackedKeywords(db, bundleId, locale) {
  let sql = 'SELECT * FROM tracked_keywords WHERE bundle_id = ?';
  const params = [bundleId];
  if (locale) {
    sql += ' AND locale = ?';
    params.push(locale);
  }
  sql += ' ORDER BY keyword';
  return db.prepare(sql).all(...params);
}

export function recordRank(db, { bundleId, keyword, locale, rank, totalResults }) {
  db.prepare(`
    INSERT INTO keyword_ranks (bundle_id, keyword, locale, rank, total_results, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bundleId, keyword, locale, rank ?? null, totalResults ?? null, Date.now());

  db.prepare(`
    UPDATE tracked_keywords SET last_tracked_at = ? WHERE bundle_id = ? AND keyword = ? AND locale = ?
  `).run(Date.now(), bundleId, keyword, locale);
}

export function getRankHistory(db, bundleId, keyword, locale, { sinceMs, limit = 100 } = {}) {
  let sql = 'SELECT * FROM keyword_ranks WHERE bundle_id = ? AND keyword = ? AND locale = ?';
  const params = [bundleId, keyword, locale];

  if (sinceMs) {
    sql += ' AND fetched_at >= ?';
    params.push(sinceMs);
  }

  sql += ' ORDER BY fetched_at DESC, id DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

export function getLatestRank(db, bundleId, keyword, locale) {
  return db.prepare(`
    SELECT * FROM keyword_ranks
    WHERE bundle_id = ? AND keyword = ? AND locale = ?
    ORDER BY fetched_at DESC, id DESC LIMIT 1
  `).get(bundleId, keyword, locale) || null;
}

export function getRankMovements(db, bundleId, locale, { sinceDays = 14, minMovement = 5 } = {}) {
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  let keywordSql = 'SELECT DISTINCT keyword FROM tracked_keywords WHERE bundle_id = ?';
  const keywordParams = [bundleId];
  if (locale) {
    keywordSql += ' AND locale = ?';
    keywordParams.push(locale);
  }
  const keywords = db.prepare(keywordSql).all(...keywordParams);

  const movements = [];

  for (const { keyword } of keywords) {
    const loc = locale || db.prepare(
      'SELECT locale FROM tracked_keywords WHERE bundle_id = ? AND keyword = ? LIMIT 1'
    ).get(bundleId, keyword)?.locale;

    if (!loc) continue;

    const ranks = db.prepare(`
      SELECT rank, fetched_at FROM keyword_ranks
      WHERE bundle_id = ? AND keyword = ? AND locale = ? AND fetched_at >= ?
      ORDER BY fetched_at ASC, id ASC
    `).all(bundleId, keyword, loc, sinceMs);

    if (ranks.length < 2) continue;

    const oldest = ranks[0];
    const newest = ranks[ranks.length - 1];
    const oldRank = oldest.rank;
    const newRank = newest.rank;

    const classification = classifyMovement(oldRank, newRank, minMovement);
    if (!classification) continue;

    movements.push({
      keyword,
      locale: loc,
      old_rank: oldRank,
      new_rank: newRank,
      delta: oldRank != null && newRank != null ? oldRank - newRank : null,
      classification,
      time_window_days: sinceDays,
    });
  }

  return movements;
}

function classifyMovement(oldRank, newRank, minMovement) {
  if (oldRank != null && newRank == null) return 'dropped_out_of_ranking';
  if (oldRank == null && newRank != null) return 'newly_ranked';

  if (oldRank == null && newRank == null) return null;

  const delta = oldRank - newRank;
  const absDelta = Math.abs(delta);

  if (oldRank > 10 && newRank <= 10) return 'entered_top_10';
  if (oldRank <= 10 && newRank > 10) return 'dropped_from_top_10';
  if (oldRank > 100 && newRank <= 100) return 'entered_top_100';

  const threshold = oldRank > 50
    ? Math.max(minMovement, Math.round(oldRank * 0.1))
    : minMovement;

  if (absDelta < threshold) return null;

  return delta > 0 ? 'climbing' : 'falling';
}
