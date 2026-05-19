// Permissions model + middleware for Turnkey Rail.
//
// A user's permissions are stored as a JSON blob on users.permissions:
//   { admin: 'full'|'none',
//     projects|schedule|vendors|payapps|changeorders|documents: 'full'|'read'|'none' }
//
// 'full' = read + write, 'read' = view only, 'none' = tab hidden.
// 'admin: full' grants access to the Admin tab (user management).
//
// Env-var (root) users always get the admin preset, regardless of what's in DB.

const TABS = ['projects', 'schedule', 'vendors', 'payapps', 'changeorders', 'documents'];
const FEATURE_LEVELS = ['none', 'read', 'full'];
const ADMIN_LEVELS = ['none', 'full'];

const PRESETS = {
  admin: {
    admin: 'full',
    projects: 'full', schedule: 'full', vendors: 'full',
    payapps: 'full', changeorders: 'full', documents: 'full',
  },
  editor: {
    admin: 'none',
    projects: 'full', schedule: 'full', vendors: 'full',
    payapps: 'full', changeorders: 'full', documents: 'full',
  },
  viewer: {
    admin: 'none',
    projects: 'read', schedule: 'read', vendors: 'read',
    payapps: 'read', changeorders: 'read', documents: 'read',
  },
};

const NONE_PERMS = {
  admin: 'none',
  projects: 'none', schedule: 'none', vendors: 'none',
  payapps: 'none', changeorders: 'none', documents: 'none',
};

// Coerce any input into a valid permissions object. Unknown fields are dropped,
// invalid levels become 'none'.
function normalize(obj) {
  obj = obj || {};
  const result = {
    admin: ADMIN_LEVELS.includes(obj.admin) ? obj.admin : 'none',
  };
  for (const tab of TABS) {
    result[tab] = FEATURE_LEVELS.includes(obj[tab]) ? obj[tab] : 'none';
  }
  return result;
}

// Parse a JSON string from the DB into a normalized permissions object.
function parse(jsonString) {
  if (!jsonString) return normalize({});
  try {
    return normalize(JSON.parse(jsonString));
  } catch {
    return normalize({});
  }
}

// Synthetic permissions for env-var (root) users — always full admin.
function envUserPermissions() {
  return { ...PRESETS.admin };
}

// Map a preset name to a permissions object (or null if unknown).
function fromPreset(name) {
  if (!name) return null;
  const preset = PRESETS[name];
  return preset ? { ...preset } : null;
}

// Derive a preset name from a permissions object, or 'custom' if it doesn't match any.
function detectPreset(perms) {
  perms = normalize(perms);
  for (const name of Object.keys(PRESETS)) {
    if (JSON.stringify(perms) === JSON.stringify(PRESETS[name])) return name;
  }
  return 'custom';
}

// Express middleware factory: require at least `level` on `tab` for req.user.
function requirePermission(tab, requiredLevel) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const perms = req.user.permissions || NONE_PERMS;
    const userLevel = perms[tab] || 'none';

    let ok = false;
    if (requiredLevel === 'read') ok = userLevel === 'read' || userLevel === 'full';
    else if (requiredLevel === 'full') ok = userLevel === 'full';

    if (!ok) {
      return res.status(403).json({ error: `Requires '${requiredLevel}' access to ${tab}` });
    }
    next();
  };
}

// Express middleware: require admin: 'full'.
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const perms = req.user.permissions || NONE_PERMS;
  if (perms.admin !== 'full') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

module.exports = {
  TABS,
  FEATURE_LEVELS,
  ADMIN_LEVELS,
  PRESETS,
  normalize,
  parse,
  envUserPermissions,
  fromPreset,
  detectPreset,
  requirePermission,
  requireAdmin,
};
