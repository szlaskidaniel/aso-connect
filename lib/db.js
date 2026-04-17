import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DB_DIR = join(PROJECT_ROOT, '.aso-connect');
const DB_PATH = join(DB_DIR, 'aso.db');

let db = null;

export function getDb() {
  if (db) return db;

  mkdirSync(DB_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  return db;
}

export function getDbPath() {
  return DB_PATH;
}

export function createMemoryDb() {
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  return memDb;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

process.on('exit', closeDb);
process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });
