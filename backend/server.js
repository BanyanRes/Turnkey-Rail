// Turnkey Rail backend entrypoint
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');

const { initDb, getDb } = require('./db/database');
const perms = require('./lib/permissions');
const sessionAuth = require('./lib/sessionAuth');

const app = express();
const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// Where the built React frontend lives (created by `vite build`).
// In production, we serve this from Express.
const DIST_DIR = path.join(__dirname, '..', 'frontend', 'dist');
const HAS_DIST = fs.existsSync(DIST_DIR);

// Initialize DB (creates file + runs schema if needed)
initDb();

// ===== Authentication =====
//
// Strategy: cookie-based session via HMAC-signed tokens (no DB session table).
// Login flow: POST /api/login with { username, password, rememberMe } → sets
// httpOnly session cookie. Logout: POST /api/logout clears it. All other API
// routes verify the cookie and populate req.user.
//
// TWO sources of users (unchanged from previous Basic Auth):
//  (a) Env-var "root" users — set via BASIC_AUTH_USERS or BASIC_AUTH_USER+PASS.
//      Always admin. Used to bootstrap or recover from lockout.
//      (Env var names kept for backwards compat; they apply to login too.)
//  (b) DB users — managed through /api/users admin endpoints.
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

/**
 * Look up a user by username/password against env users and DB users.
 * Returns the populated req.user object on success, or null on failure.
 */
async function authenticateCredentials(username, password) {
  if (!username || !password) return null;

  // 1) Env-var users — always admin (root), full permissions on everything
  if (ENV_USERS.get(username) === password) {
    return {
      username,
      is_admin: true,
      source: 'env',
      permissions: perms.envUserPermissions(),
    };
  }

  // 2) DB users — bcrypt-compared, permissions parsed from JSON column
  const db = getDb();
  const dbUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (dbUser) {
    const ok = await bcrypt.compare(password, dbUser.password_hash);
    if (ok) {
      return {
        username: dbUser.username,
        is_admin: !!dbUser.is_admin,
        source: 'db',
        id: dbUser.id,
        email: dbUser.email || null,
        permissions: perms.parse(dbUser.permissions),
      };
    }
  }

  return null;
}

/**
 * Rebuild req.user from a verified session token's payload.
 * Re-reads the DB each request so permission changes take effect immediately
 * (no need to log users out when their permissions are updated).
 */
function rehydrateUser(payload) {
  if (!payload || !payload.u) return null;

  if (payload.src === 'env') {
    // Env users still need to exist in ENV_USERS, else their session is stale
    if (!ENV_USERS.has(payload.u)) return null;
    return {
      username: payload.u,
      is_admin: true,
      source: 'env',
      permissions: perms.envUserPermissions(),
    };
  }

  if (payload.src === 'db') {
    const db = getDb();
    const dbUser = db.prepare('SELECT * FROM users WHERE username = ?').get(payload.u);
    if (!dbUser) return null;
    return {
      username: dbUser.username,
      is_admin: !!dbUser.is_admin,
      source: 'db',
      id: dbUser.id,
      email: dbUser.email || null,
      permissions: perms.parse(dbUser.permissions),
    };
  }

  return null;
}

/**
 * Express middleware: verify session cookie, populate req.user, or 401.
 * Public routes (invitation acceptance, non-API SPA assets, /api/login,
 * /api/health) are exempt.
 */
function cookieAuth(req, res, next) {
  // Public: invitation acceptance (user has no creds yet)
  if (req.path.startsWith('/api/invitations/token/')) return next();

  // Public: login & logout themselves
  if (req.path === '/api/login' || req.path === '/api/logout') return next();

  // Public: health check
  if (req.path === '/api/health') return next();

  // Public: anything outside /api is the React SPA bundle (HTML/JS/CSS)
  if (!req.path.startsWith('/api')) return next();

  const db = getDb();
  const dbHasUsers = db.prepare('SELECT 1 FROM users LIMIT 1').get();

  // Dev mode: no users anywhere -> bypass auth
  if (ENV_USERS.size === 0 && !dbHasUsers) {
    req.user = {
      username: 'dev',
      is_admin: true,
      source: 'none',
      permissions: perms.envUserPermissions(),
    };
    return next();
  }

  // Verify session cookie
  const token = req.cookies && req.cookies[sessionAuth.COOKIE_NAME];
  const payload = sessionAuth.verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = rehydrateUser(payload);
  if (!user) {
    // Session was valid but the underlying user is gone or env entry removed.
    sessionAuth.clearSessionCookie(req, res);
    return res.status(401).json({ error: 'Session invalid' });
  }

  req.user = user;
  return next();
}

// Admin gate, now driven by permissions.admin === 'full' (set by cookieAuth above).
const requireAdmin = perms.requireAdmin;

// ===== Middleware =====
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(morgan('dev'));
// cookieAuth runs BEFORE all routes so req.user is always populated (except on public routes)
app.use(cookieAuth);

// ===== Health =====
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'Turnkey Rail API', time: new Date().toISOString() });
});

// ===== Authentication endpoints =====
//
// POST /api/login   { username, password, rememberMe } -> sets session cookie
// POST /api/logout                                     -> clears session cookie
// GET  /api/me                                         -> current user (via cookie)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body || {};
    const user = await authenticateCredentials(username, password);
    if (!user) {
      // Generic message — don't reveal whether user exists.
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const { token, maxAgeSec } = sessionAuth.createToken(
      { u: user.username, src: user.source },
      !!rememberMe
    );
    sessionAuth.setSessionCookie(req, res, token, maxAgeSec);
    return res.json({ user });
  } catch (err) {
    console.error('[login]', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  sessionAuth.clearSessionCookie(req, res);
  return res.json({ ok: true });
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
