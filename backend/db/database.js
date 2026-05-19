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
  console.log(`[db] connected at ${DB_PATH}`);
  return db;
}

function getDb() {
  if (!db) initDb();
  return db;
}

module.exports = { initDb, getDb };
