-- BuildCore schema
-- Idempotent: safe to re-run on every boot.

CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT    NOT NULL UNIQUE,                 -- short ID, e.g. "BC-001"
  name            TEXT    NOT NULL,
  address         TEXT,
  status          TEXT    NOT NULL DEFAULT 'active',       -- active | on_hold | completed | archived
  contract_amount REAL,                                    -- signed contract total (nullable)
  start_date      TEXT,                                    -- ISO yyyy-mm-dd
  end_date        TEXT,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS budget_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_code        TEXT    NOT NULL,                       -- free text: "1000", "01-100", "Framing", etc.
  category         TEXT,                                   -- optional grouping: "Sitework", "Framing", "MEP", ...
  description      TEXT    NOT NULL,
  budgeted_amount  REAL    NOT NULL DEFAULT 0,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_lines_project ON budget_lines(project_id);
CREATE INDEX IF NOT EXISTS idx_budget_lines_cost_code ON budget_lines(project_id, cost_code);

-- Subcontractors / vendors master
CREATE TABLE IF NOT EXISTS subcontractors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  trade            TEXT,                                    -- e.g. "Framing", "Plumbing", "Drywall"
  contact_name     TEXT,
  email            TEXT,
  phone            TEXT,
  address          TEXT,
  license_number   TEXT,
  tax_id           TEXT,                                    -- EIN / SSN (sensitive, stored locally only)
  insurance_expiry TEXT,                                    -- ISO yyyy-mm-dd
  status           TEXT    NOT NULL DEFAULT 'active',       -- active | inactive
  notes            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subs_status ON subcontractors(status);
CREATE INDEX IF NOT EXISTS idx_subs_trade ON subcontractors(trade);

-- Pay applications (header: a vendor invoicing a project for a billing period)
CREATE TABLE IF NOT EXISTS pay_applications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subcontractor_id  INTEGER REFERENCES subcontractors(id) ON DELETE SET NULL,
  app_number        INTEGER NOT NULL,                       -- pay app # for this project+vendor
  period_start      TEXT,                                   -- ISO yyyy-mm-dd
  period_end        TEXT,
  submitted_date    TEXT,
  status            TEXT    NOT NULL DEFAULT 'draft',       -- draft | submitted | approved | paid | rejected
  contract_sum      REAL    NOT NULL DEFAULT 0,             -- vendor's contract total on this project
  change_orders     REAL    NOT NULL DEFAULT 0,
  retainage_pct     REAL    NOT NULL DEFAULT 10,            -- 10% standard
  notes             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payapps_project ON pay_applications(project_id);
CREATE INDEX IF NOT EXISTS idx_payapps_sub ON pay_applications(subcontractor_id);
CREATE INDEX IF NOT EXISTS idx_payapps_status ON pay_applications(status);

-- Pay application line items (G703 detail)
CREATE TABLE IF NOT EXISTS pay_app_lines (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  pay_app_id             INTEGER NOT NULL REFERENCES pay_applications(id) ON DELETE CASCADE,
  budget_line_id         INTEGER REFERENCES budget_lines(id) ON DELETE SET NULL,
  description            TEXT    NOT NULL,
  scheduled_value        REAL    NOT NULL DEFAULT 0,        -- G703 col C
  completed_previous     REAL    NOT NULL DEFAULT 0,        -- col D
  completed_this_period  REAL    NOT NULL DEFAULT 0,        -- col E
  stored_materials       REAL    NOT NULL DEFAULT 0,        -- col F
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payapplines_payapp ON pay_app_lines(pay_app_id);

-- Change orders (contract modifications)
-- subcontractor_id null = owner CO (affects project contract)
-- subcontractor_id set = sub CO (affects that vendor's contract on the project)
CREATE TABLE IF NOT EXISTS change_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subcontractor_id  INTEGER REFERENCES subcontractors(id) ON DELETE SET NULL,
  co_number         INTEGER NOT NULL,                       -- sequential per project+vendor
  description       TEXT    NOT NULL,
  reason            TEXT,                                   -- "Owner request" | "Unforeseen" | "Design change" | "Allowance recon" | etc.
  amount            REAL    NOT NULL DEFAULT 0,             -- positive = add, negative = deduct
  days_added        INTEGER NOT NULL DEFAULT 0,             -- schedule impact
  requested_date    TEXT,                                   -- ISO yyyy-mm-dd
  approved_date     TEXT,
  status            TEXT    NOT NULL DEFAULT 'draft',       -- draft | submitted | approved | rejected | void
  notes             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cos_project ON change_orders(project_id);
CREATE INDEX IF NOT EXISTS idx_cos_sub ON change_orders(subcontractor_id);
CREATE INDEX IF NOT EXISTS idx_cos_status ON change_orders(status);

-- Documents (file uploads tied to projects)
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  category      TEXT,                              -- plans | contract | permit | photo | invoice | other
  filename      TEXT    NOT NULL,                  -- original filename
  stored_path   TEXT    NOT NULL,                  -- relative path under data/files/
  mime_type     TEXT,
  size_bytes    INTEGER,
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_docs_project ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_docs_category ON documents(category);

-- Schedule / Gantt tasks (per project)
CREATE TABLE IF NOT EXISTS schedule_tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  start_date       TEXT,                                  -- ISO yyyy-mm-dd
  end_date         TEXT,
  progress         INTEGER NOT NULL DEFAULT 0,            -- 0-100
  subcontractor_id INTEGER REFERENCES subcontractors(id) ON DELETE SET NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON schedule_tasks(project_id);

-- Application users (for admin UI; basic auth credentials beyond env vars)
-- Env-var users (BASIC_AUTH_USERS) are always admin and not stored here.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,            -- bcrypt
  is_admin      INTEGER NOT NULL DEFAULT 0,  -- 0/1
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
