// User management (admin only). Mounted in server.js with requireAdmin middleware.
//
// In the new flow, users are normally created via the invitation endpoints
// (see routes/invitations.js). POST /api/users still works for direct admin
// creation as an escape hatch, but the primary creation path is invite-accept.
const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const perms = require('../lib/permissions');

const router = express.Router();

const SALT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 8;

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    is_admin: !!row.is_admin,
    email: row.email || null,
    permissions: perms.parse(row.permissions),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Resolve {permissions, preset} from a request body into a normalized perms
// object. Returns null if neither was provided.
function resolvePermissionsInput(body) {
  if (body.preset) {
    return perms.fromPreset(body.preset);
  }
  if (body.permissions) {
    return perms.normalize(body.permissions);
  }
  return null;
}

// GET /api/users  — list (without password hashes)
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, username, is_admin, email, permissions, created_at, updated_at
    FROM users
    ORDER BY username ASC
  `).all();
  res.json(rows.map(publicUser));
});

// POST /api/users  — direct create (escape hatch; normal flow is invitation-accept)
router.post('/', async (req, res) => {
  const db = getDb();
  const { username, password, is_admin, email } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (typeof username !== 'string' || username.includes(':') || username.includes(',') || username.includes(' ')) {
    return res.status(400).json({ error: 'username cannot contain spaces, ":" or ","' });
  }
  if (password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
  }
  // Reserve env-var usernames so they can't be shadowed
  const envUsernames = collectEnvUsernames();
  if (envUsernames.has(username)) {
    return res.status(409).json({ error: `"${username}" is already an env-var (root) user; pick a different username` });
  }

  // Permissions: from body.preset, body.permissions, or fall back to is_admin flag
  let normPerms = resolvePermissionsInput(req.body);
  if (!normPerms) {
    normPerms = is_admin ? perms.fromPreset('admin') : perms.fromPreset('viewer');
  }
  const isAdminFlag = normPerms.admin === 'full' ? 1 : 0;

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  try {
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, is_admin, email, permissions)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, password_hash, isAdminFlag, email || null, JSON.stringify(normPerms));
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(publicUser(row));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `User "${username}" already exists` });
    }
    throw e;
  }
});

// PATCH /api/users/:id  — change password and/or permissions
router.patch('/:id', async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const updates = [];
  const values = { id };

  if (typeof req.body.password === 'string' && req.body.password.length > 0) {
    if (req.body.password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
    }
    updates.push('password_hash = @password_hash');
    values.password_hash = await bcrypt.hash(req.body.password, SALT_ROUNDS);
  }

  // Permissions update — accept either preset name or explicit permissions object.
  // Legacy is_admin flag is also accepted as a shortcut (admin preset / viewer preset).
  let newPerms = resolvePermissionsInput(req.body);
  if (!newPerms && 'is_admin' in req.body) {
    newPerms = req.body.is_admin ? perms.fromPreset('admin') : perms.fromPreset('viewer');
  }

  if (newPerms) {
    // Self-protection: prevent demoting yourself out of admin
    if (req.user && req.user.username === existing.username && newPerms.admin !== 'full') {
      return res.status(400).json({ error: 'You cannot remove your own admin privilege' });
    }
    updates.push('permissions = @permissions');
    values.permissions = JSON.stringify(newPerms);
    updates.push('is_admin = @is_admin');
    values.is_admin = newPerms.admin === 'full' ? 1 : 0;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updatable fields (allowed: password, permissions, preset, is_admin)' });
  }
  updates.push("updated_at = datetime('now')");

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = @id`).run(values);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json(publicUser(row));
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  // Prevent deleting yourself
  if (req.user && req.user.username === existing.username) {
    return res.status(400).json({ error: 'You cannot delete yourself' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true, deleted: id });
});

// Internal helper — collect usernames from env vars (so we can reject collisions)
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

module.exports = router;
