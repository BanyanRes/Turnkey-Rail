// Turnkey Rail backend entrypoint
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');

const { initDb, getDb } = require('./db/database');
const perms = require('./lib/permissions');

const app = express();
const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// Where the built React frontend lives (created by `vite build`).
// In production, we serve this from Express.
const DIST_DIR = path.join(__dirname, '..', 'frontend', 'dist');
const HAS_DIST = fs.existsSync(DIST_DIR);

// Initialize DB (creates file + runs schema if needed)
initDb();

// ===== Basic Auth =====
//
// TWO sources of users:
//  (a) Env-var "root" users — set via BASIC_AUTH_USERS or BASIC_AUTH_USER+PASS.
//      These are always admin and cannot be removed via the UI. Use them
//      to bootstrap or recover from lockout.
//  (b) DB users — managed through the /api/users admin endpoints (see routes/users.js).
//      Stored with bcrypt-hashed passwords, can be admin or non-admin.
//
// Auth bypass: if NEITHER source has any users, the app runs wide open
// (dev mode convenience). As soon as at least one user exists anywhere,
// auth is required.
function parseEnvUsers() {
  const map = new Map();
  if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS) {
    map.set(process.env.BASIC_AUTH_USER, process.env.BASIC_AUTH_PASS);
  }
  const multi = process.env.BASIC_AUTH_USERS;
  if (multi) {
    for (const pair of multi.split(',')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) continue;
      const u = trimmed.slice(0, idx);
      const p = trimmed.slice(idx + 1);
      if (u && p) map.set(u, p);
    }
  }
  return map;
}
const ENV_USERS = parseEnvUsers();
if (ENV_USERS.size > 0) {
  console.log(`[auth] ${ENV_USERS.size} env-var (root) user(s) loaded`);
}

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="Turnkey Rail", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

async function basicAuth(req, res, next) {
  // Public bypass: invitation-acceptance routes have no auth — the user signing
  // up doesn't have creds yet. Server.js controls this rather than the router
  // because app.use(basicAuth) is global.
  if (req.path.startsWith('/api/invitations/token/')) {
    return next();
  }

  // Public bypass: anything that isn't an API call is the React SPA bundle
  // (HTML, JS, CSS, /invite/<token> SPA route, etc). Static assets don't need
  // auth — the API does. The browser will still get prompted on the first
  // /api/me call, so the practical UX is unchanged for normal sign-in.
  if (!req.path.startsWith('/api')) {
    return next();
  }

  const db = getDb();
  const dbHasUsers = db.prepare('SELECT 1 FROM users LIMIT 1').get();

  // Dev mode: no users anywhere -> bypass auth, pretend you're a dev admin.
  if (ENV_USERS.size === 0 && !dbHasUsers) {
    req.user = {
      username: 'dev',
      is_admin: true,
      source: 'none',
      permissions: perms.envUserPermissions(),
    };
    return next();
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return unauthorized(res);

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return unauthorized(res);
  }
  const idx = decoded.indexOf(':');
  if (idx <= 0) return unauthorized(res);
  const u = decoded.slice(0, idx);
  const p = decoded.slice(idx + 1);

  // 1) Env-var users — always admin (root), full permissions on everything
  if (ENV_USERS.get(u) === p) {
    req.user = {
      username: u,
      is_admin: true,
      source: 'env',
      permissions: perms.envUserPermissions(),
    };
    return next();
  }

  // 2) DB users — bcrypt-compared, permissions parsed from JSON column
  const dbUser = db.prepare('SELECT * FROM users WHERE username = ?').get(u);
  if (dbUser) {
    const ok = await bcrypt.compare(p, dbUser.password_hash);
    if (ok) {
      req.user = {
        username: dbUser.username,
        is_admin: !!dbUser.is_admin,
        source: 'db',
        id: dbUser.id,
        email: dbUser.email || null,
        permissions: perms.parse(dbUser.permissions),
      };
      return next();
    }
  }

  return unauthorized(res);
}

// Admin gate, now driven by permissions.admin === 'full' (set by basicAuth above).
const requireAdmin = perms.requireAdmin;

// ===== Middleware =====
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
// basicAuth runs BEFORE all routes so req.user is always populated
app.use(basicAuth);

// ===== Health =====
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'Turnkey Rail API', time: new Date().toISOString() });
});

// ===== Current user =====
app.get('/api/me', (req, res) => {
  res.json(req.user || null);
});

// ===== API routes =====
// Method-aware permission gate: GET requires 'read', writes require 'full'.
const gate = (tab) => (req, res, next) => {
  const level = req.method === 'GET' ? 'read' : 'full';
  return perms.requirePermission(tab, level)(req, res, next);
};

app.use('/api/projects', gate('projects'), require('./routes/projects'));
app.use('/api/budget-lines', gate('projects'), require('./routes/budgetLines'));
app.use('/api/subcontractors', gate('vendors'), require('./routes/subcontractors'));
app.use('/api/pay-apps', gate('payapps'), require('./routes/payApplications').router);
app.use('/api/pay-app-lines', gate('payapps'), require('./routes/payAppLines'));
app.use('/api/change-orders', gate('changeorders'), require('./routes/changeOrders'));
app.use('/api/documents', gate('documents'), require('./routes/documents'));
app.use('/api/tasks', gate('schedule'), require('./routes/tasks'));
app.use('/api/lien-waivers', gate('liens'), require('./routes/lienWaivers'));
app.use('/api/users', requireAdmin, require('./routes/users'));
app.use('/api/invitations', require('./routes/invitations'));

// /api/* 404 — scoped so unmatched non-API routes can fall through to SPA fallback below
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ===== Static frontend (production) =====
if (HAS_DIST) {
  app.use(express.static(DIST_DIR));
  app.use((req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  console.log(`[static] serving frontend from ${DIST_DIR}`);
} else {
  console.log('[static] no frontend dist found; running API-only (dev mode)');
}

// ===== Error handler =====
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Turnkey Rail API listening on http://localhost:${PORT}`);
});
