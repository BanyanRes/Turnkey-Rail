// BuildCore SQLite connection + schema bootstrapper
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'buildcore.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function initDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (fs.existsSync(SCHEMA_PATH)) {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    if (schema.trim().length > 0) {
      db.exec(schema);
    }
  }
  runMigrations(db);
  console.log(`[db] connected at ${DB_PATH}`);
  return db;
}

// Idempotent migrations for columns that CREATE TABLE IF NOT EXISTS can't add
// to pre-existing tables. Safe to re-run on every boot.
function runMigrations(db) {
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('email')) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT");
    console.log('[db migrate] users.email added');
  }
  if (!userCols.includes('permissions')) {
    db.exec("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}'");
    console.log('[db migrate] users.permissions added');
    // Backfill: existing is_admin=1 rows get the admin preset; the rest get viewer.
    // JSON literals here so we don't depend on the permissions lib at boot time.
    const adminPerms = JSON.stringify({
      admin: 'full',
      projects: 'full', schedule: 'full', vendors: 'full',
      payapps: 'full', changeorders: 'full', documents: 'full',
    });
    const viewerPerms = JSON.stringify({
      admin: 'none',
      projects: 'read', schedule: 'read', vendors: 'read',
      payapps: 'read', changeorders: 'read', documents: 'read',
    });
    db.prepare("UPDATE users SET permissions = ? WHERE is_admin = 1 AND (permissions IS NULL OR permissions = '{}' OR permissions = '')").run(adminPerms);
    db.prepare("UPDATE users SET permissions = ? WHERE is_admin = 0 AND (permissions IS NULL OR permissions = '{}' OR permissions = '')").run(viewerPerms);
    console.log('[db migrate] users.permissions backfilled');
  }
}

function getDb() {
  if (!db) initDb();
  return db;
}

module.exports = { initDb, getDb };
