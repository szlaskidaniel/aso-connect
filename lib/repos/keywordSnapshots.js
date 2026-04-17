export function appendSnapshot(db, { keyword, locale, popularity, difficulty, opportunity, rawJson }) {
  db.prepare(`
    INSERT INTO keyword_snapshots (keyword, locale, popularity, difficulty, opportunity, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(keyword, locale, popularity, difficulty, opportunity, rawJson ?? null, Date.now());
}

export function getHistory(db, keyword, locale, { sinceMs, limit = 100 } = {}) {
  let sql = 'SELECT * FROM keyword_snapshots WHERE keyword = ? AND locale = ?';
  const params = [keyword, locale];

  if (sinceMs) {
    sql += ' AND fetched_at >= ?';
    params.push(sinceMs);
  }

  sql += ' ORDER BY fetched_at DESC, id DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}
