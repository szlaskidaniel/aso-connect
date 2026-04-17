export function setActiveKeywords(db, bundleId, locale, keywords) {
  const run = db.transaction(() => {
    const current = db.prepare(
      'SELECT keyword FROM active_keywords WHERE bundle_id = ? AND locale = ?'
    ).all(bundleId, locale).map(r => r.keyword);

    const newSet = new Set(keywords);
    const currentSet = new Set(current);

    const toDelete = current.filter(k => !newSet.has(k));
    const toInsert = keywords.filter(k => !currentSet.has(k));

    if (toDelete.length > 0) {
      const delStmt = db.prepare(
        'DELETE FROM active_keywords WHERE bundle_id = ? AND locale = ? AND keyword = ?'
      );
      for (const kw of toDelete) delStmt.run(bundleId, locale, kw);
    }

    if (toInsert.length > 0) {
      const insStmt = db.prepare(`
        INSERT INTO active_keywords (bundle_id, locale, keyword, added_at)
        VALUES (?, ?, ?, ?)
      `);
      const now = Date.now();
      for (const kw of toInsert) insStmt.run(bundleId, locale, kw, now);
    }
  });

  run();
}

export function getActiveKeywords(db, bundleId, locale) {
  return db.prepare(
    'SELECT * FROM active_keywords WHERE bundle_id = ? AND locale = ? ORDER BY keyword'
  ).all(bundleId, locale);
}

export function updateKeywordScore(db, bundleId, locale, keyword, { popularity, difficulty, opportunity }) {
  db.prepare(`
    UPDATE active_keywords
    SET last_score_popularity = ?, last_score_difficulty = ?, last_score_opportunity = ?, last_scored_at = ?
    WHERE bundle_id = ? AND locale = ? AND keyword = ?
  `).run(popularity, difficulty, opportunity, Date.now(), bundleId, locale, keyword);
}

export function getKeywordAge(db, bundleId, locale, keyword) {
  const row = db.prepare(
    'SELECT added_at FROM active_keywords WHERE bundle_id = ? AND locale = ? AND keyword = ?'
  ).get(bundleId, locale, keyword);

  if (!row) return null;
  return Math.floor((Date.now() - row.added_at) / (1000 * 60 * 60 * 24));
}
