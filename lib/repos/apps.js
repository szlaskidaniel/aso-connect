export function upsertApp(db, bundleId, { name = null, primaryCategoryId = null } = {}) {
  db.prepare(`
    INSERT INTO apps (bundle_id, name, primary_category_id, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bundle_id) DO UPDATE SET
      name = COALESCE(excluded.name, apps.name),
      primary_category_id = COALESCE(excluded.primary_category_id, apps.primary_category_id)
  `).run(bundleId, name, primaryCategoryId, Date.now());
}

export function getApp(db, bundleId) {
  return db.prepare('SELECT * FROM apps WHERE bundle_id = ?').get(bundleId) || null;
}

export function listApps(db) {
  return db.prepare('SELECT * FROM apps ORDER BY added_at DESC').all();
}
