// Invitation routes.
//
// Admin endpoints (mounted under /api/invitations, gated by perms.requireAdmin):
//   POST   /                       create an invite, returns the token + URL
//   GET    /                       list pending (unaccepted, unexpired) invites
//   DELETE /:id                    revoke
//
// Public endpoints (NO auth — the user accepting the invite has no creds yet):
//   GET    /token/:token           validate token, return email + permissions
//   POST   /token/:token/accept    consume token, create user
//
// The public paths use the /token/ prefix so server.js can easily bypass
// basicAuth for them, and so /:id (admin) can't collide with /:token (public).
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const perms = require('../lib/permissions');

const router = express.Router();

const TOKEN_BYTES = 32;            // 64 hex chars
const INVITE_TTL_DAYS = 7;
const SALT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 8;

// Shape an invitation row for JSON responses.
// `includeToken` = include the raw token (admin-side); never expose on public GET.
function shapeInvite(row, { includeToken = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    email: row.email,
    permissions: perms.parse(row.permissions),
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
  };
  if (includeToken) out.token = row.token;
  return out;
}

// SQLite stores expires_at as a naive datetime string ("YYYY-MM-DD HH:MM:SS")
// in UTC (we generate it via datetime('now', '+7 days')). Compare as UTC.
function isExpired(expiresAt) {
  if (!expiresAt) return true;
  // datetime('now') produces "YYYY-MM-DD HH:MM:SS" UTC; treat as UTC by appending Z.
  const iso = expiresAt.replace(' ', 'T') + 'Z';
  return new Date(iso) < new Date();
}

// Usernames already in BASIC_AUTH_USERS env var — can't be shadowed by a DB user.
function collectEnvUsernames() {
  const set = new Set();
  if (process.env.BASIC_AUTH_USER) set.add(process.env.BASIC_AUTH_USER);
  const multi = process.env.BASIC_AUTH_USERS;
  if (multi) {
    for (const pair of multi.split(',')) {
      const idx = pair.indexOf(':');
      if (idx > 0) set.add(pair.slice(0, idx).trim());
    }
  }
  return set;
}

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

// POST /api/invitations — create a new invitation
router.post('/', perms.requireAdmin, (req, res) => {
  const db = getDb();
  const { email, permissions: requestedPerms, preset } = req.body || {};

  if (!email || typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  // Accept either an explicit permissions object or a preset name.
  let normPerms;
  if (preset) {
    const fromPreset = perms.fromPreset(preset);
    if (!fromPreset) return res.status(400).json({ error: `Unknown preset: ${preset}` });
    normPerms = fromPreset;
  } else {
    normPerms = perms.normalize(requestedPerms);
  }

  // Generate token + expiry
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = db.prepare("SELECT datetime('now', ?) AS t").get(`+${INVITE_TTL_DAYS} days`).t;

  const info = db.prepare(`
    INSERT INTO invitations (email, token, permissions, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(email, token, JSON.stringify(normPerms), req.user.username, expiresAt);

  const row = db.prepare('SELECT * FROM invitations WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(shapeInvite(row, { includeToken: true }));
});

// GET /api/invitations — list pending (unaccepted, unexpired) invitations
router.get('/', perms.requireAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM invitations
    WHERE accepted_at IS NULL AND expires_at > datetime('now')
    ORDER BY created_at DESC
  `).all();
  res.json(rows.map(r => shapeInvite(r, { includeToken: true })));
});

// DELETE /api/invitations/:id — revoke
// Note: Express 5 dropped inline regex constraints on params; we validate
// numeric id in the handler. The public /token/:token routes can't collide
// because they have a literal "token" segment before the variable.
router.delete('/:id', perms.requireAdmin, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid invitation id' });
  }
  const existing = db.prepare('SELECT * FROM invitations WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Invitation not found' });
  db.prepare('DELETE FROM invitations WHERE id = ?').run(id);
  res.json({ ok: true, deleted: id });
});

// ============================================================
// PUBLIC ENDPOINTS (no auth — server.js bypasses basicAuth for /token/*)
// ============================================================

// GET /api/invitations/token/:token — validate a token, return invite details
router.get('/token/:token', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM invitations WHERE token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Invitation not found' });
  if (row.accepted_at) return res.status(410).json({ error: 'This invitation has already been used' });
  if (isExpired(row.expires_at)) return res.status(410).json({ error: 'This invitation has expired' });
  // Don't echo the token back; the client already has it in the URL.
  res.json(shapeInvite(row, { includeToken: false }));
});

// POST /api/invitations/token/:token/accept — consume token, create user
router.post('/token/:token/accept', async (req, res) => {
  const db = getDb();
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (typeof username !== 'string' || username.includes(':') || username.includes(',') || username.includes(' ')) {
    return res.status(400).json({ error: 'username cannot contain spaces, ":" or ","' });
  }
  if (password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
  }

  const invite = db.prepare('SELECT * FROM invitations WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invitation not found' });
  if (invite.accepted_at) return res.status(410).json({ error: 'This invitation has already been used' });
  if (isExpired(invite.expires_at)) return res.status(410).json({ error: 'This invitation has expired' });

  // Username collision check (env users + DB users)
  if (collectEnvUsernames().has(username)) {
    return res.status(409).json({ error: `Username "${username}" is taken` });
  }
  const existingUser = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (existingUser) {
    return res.status(409).json({ error: `Username "${username}" is taken` });
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const normPerms = perms.parse(invite.permissions);
  const isAdmin = normPerms.admin === 'full' ? 1 : 0;
  const permsJson = JSON.stringify(normPerms);

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, is_admin, email, permissions)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, password_hash, isAdmin, invite.email, permsJson);
    db.prepare(`
      UPDATE invitations
      SET accepted_at = datetime('now'), accepted_user_id = ?
      WHERE id = ?
    `).run(info.lastInsertRowid, invite.id);
    return info.lastInsertRowid;
  });
  const userId = tx();
  res.status(201).json({ ok: true, user_id: userId, username });
});

module.exports = router;
