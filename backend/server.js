// Turnkey Rail backend entrypoint
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const { initDb } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// Where the built React frontend lives (created by `vite build`).
// In production, we serve this from Express.
const DIST_DIR = path.join(__dirname, '..', 'frontend', 'dist');
const HAS_DIST = fs.existsSync(DIST_DIR);

// Initialize DB (creates file + runs schema if needed)
initDb();

// ===== Basic Auth (opt-in via env vars) =====
// If BASIC_AUTH_USER + BASIC_AUTH_PASS are set, every request requires
// HTTP Basic Auth. Browsers handle this with a native login prompt.
// For local dev, leave the vars unset and auth is bypassed entirely.
function basicAuth(req, res, next) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Turnkey Rail", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

// ===== Middleware =====
app.use(basicAuth);
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// ===== Health =====
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'Turnkey Rail API', time: new Date().toISOString() });
});

// ===== API routes =====
app.use('/api/projects', require('./routes/projects'));
app.use('/api/budget-lines', require('./routes/budgetLines'));
app.use('/api/subcontractors', require('./routes/subcontractors'));
app.use('/api/pay-apps', require('./routes/payApplications').router);
app.use('/api/pay-app-lines', require('./routes/payAppLines'));
app.use('/api/change-orders', require('./routes/changeOrders'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/tasks', require('./routes/tasks'));

// /api/* 404 — scoped so unmatched non-API routes can fall through to SPA fallback below
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ===== Static frontend (production) =====
// Only mounted when a built dist exists. In dev, Vite serves the frontend
// separately at :5173 and proxies /api to this backend.
if (HAS_DIST) {
  app.use(express.static(DIST_DIR));
  // SPA fallback — any non-API, non-static route returns index.html
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
