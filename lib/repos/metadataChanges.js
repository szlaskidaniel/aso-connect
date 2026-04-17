export function logChange(db, { bundleId, locale, field, oldValue, newValue, source }) {
  db.prepare(`
    INSERT INTO metadata_changes (bundle_id, locale, field, old_value, new_value, changed_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(bundleId, locale, field, oldValue ?? null, newValue ?? null, Date.now(), source ?? null);
}

export function getChangesFor(db, bundleId, locale, { field, sinceMs, limit = 50 } = {}) {
  let sql = 'SELECT * FROM metadata_changes WHERE bundle_id = ? AND locale = ?';
  const params = [bundleId, locale];

  if (field) {
    sql += ' AND field = ?';
    params.push(field);
  }
  if (sinceMs) {
    sql += ' AND changed_at >= ?';
    params.push(sinceMs);
  }

  sql += ' ORDER BY changed_at DESC, id DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

export function getLastChange(db, bundleId, locale, field) {
  return db.prepare(`
    SELECT * FROM metadata_changes
    WHERE bundle_id = ? AND locale = ? AND field = ?
    ORDER BY changed_at DESC, id DESC LIMIT 1
  `).get(bundleId, locale, field) || null;
}
