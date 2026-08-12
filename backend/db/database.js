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

  // Backfill 'liens' permission for any user rows missing it. Match the user's
  // existing payapps level so liens visibility tracks pay-app visibility for
  // pre-Liens-tab accounts.
  const rows = db.prepare("SELECT id, permissions FROM users WHERE permissions IS NOT NULL AND permissions != ''").all();
  let liensAdded = 0;
  for (const r of rows) {
    let parsed;
    try { parsed = JSON.parse(r.permissions); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null) continue;
    if ('liens' in parsed) continue;
    parsed.liens = parsed.payapps || 'none';
    db.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .run(JSON.stringify(parsed), r.id);
    liensAdded++;
  }
  if (liensAdded > 0) {
    console.log(`[db migrate] users.permissions.liens backfilled on ${liensAdded} row(s)`);
  }

  // documents.pay_app_id — links a document to a specific pay app so the
  // monthly close-out package can be one folder of receipts/photos/invoices.
  // Nullable: documents can exist before any pay app is open (e.g. plans,
  // permits) and are simply attached when a pay app is created later.
  const docCols = db.prepare("PRAGMA table_info(documents)").all().map(c => c.name);
  if (!docCols.includes('pay_app_id')) {
    db.exec("ALTER TABLE documents ADD COLUMN pay_app_id INTEGER REFERENCES pay_applications(id) ON DELETE SET NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_docs_pay_app ON documents(pay_app_id)");
    console.log('[db migrate] documents.pay_app_id added');
  }

  // pay_applications: CloudLedger integration columns
  //   payment_method — for sub pay apps: 'wire'|'ach'|'check'|'bill_com'.
  //     Null for owner pay apps (they don't have an outgoing payment).
  //   cloudledger_je_approved_id — CL journal entry created at approved status.
  //     For sub: Dr.CIP/Cr.AP-Sub.  For owner: Dr.AR/Cr.Billings-Uncompleted.
  //   cloudledger_je_paid_id — CL journal entry created at paid status.
  //     For sub: Dr.AP-Sub/Cr.Cash.  For owner: Dr.Cash/Cr.AR.
  const payAppCols = db.prepare("PRAGMA table_info(pay_applications)").all().map(c => c.name);
  if (!payAppCols.includes('payment_method')) {
    db.exec("ALTER TABLE pay_applications ADD COLUMN payment_method TEXT");
    console.log('[db migrate] pay_applications.payment_method added');
  }
  if (!payAppCols.includes('cloudledger_je_approved_id')) {
    db.exec("ALTER TABLE pay_applications ADD COLUMN cloudledger_je_approved_id INTEGER");
    console.log('[db migrate] pay_applications.cloudledger_je_approved_id added');
  }
  if (!payAppCols.includes('cloudledger_je_paid_id')) {
    db.exec("ALTER TABLE pay_applications ADD COLUMN cloudledger_je_paid_id INTEGER");
    console.log('[db migrate] pay_applications.cloudledger_je_paid_id added');
  }

  // projects: link to CloudLedger entity (set on first sync)
  const projCols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
  if (!projCols.includes('cloudledger_entity_id')) {
    db.exec("ALTER TABLE projects ADD COLUMN cloudledger_entity_id INTEGER");
    console.log('[db migrate] projects.cloudledger_entity_id added');
  }
  if (!projCols.includes('owner_name')) {
    db.exec("ALTER TABLE projects ADD COLUMN owner_name TEXT");
    console.log('[db migrate] projects.owner_name added');
  }

  // change_orders.cost_code — optional cost-code tag so approved owner change
  // orders (OCOs) and executed/pending sub change orders land on the correct
  // row of the project Cost Report. Null = unallocated: the CO amount rolls
  // into an "Unallocated" line on the report so nothing is silently dropped.
  const coCols = db.prepare("PRAGMA table_info(change_orders)").all().map(c => c.name);
  if (!coCols.includes('cost_code')) {
    db.exec("ALTER TABLE change_orders ADD COLUMN cost_code TEXT");
    console.log('[db migrate] change_orders.cost_code added');
  }
}

function getDb() {
  if (!db) initDb();
  return db;
}

module.exports = { initDb, getDb };
