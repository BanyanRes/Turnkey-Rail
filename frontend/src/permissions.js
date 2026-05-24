// Frontend mirror of backend/lib/permissions.js — same shape and presets,
// plus a few friendly labels for UI rendering. Keep these in sync.

export const TABS = [
  { id: 'projects', label: 'Projects' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'vendors', label: 'Vendors' },
  { id: 'payapps', label: 'Pay Apps' },
  { id: 'changeorders', label: 'Change Orders' },
  { id: 'documents', label: 'Documents' },
];

export const FEATURE_LEVELS = [
  { id: 'none', label: 'None' },
  { id: 'read', label: 'View only' },
  { id: 'full', label: 'Edit' },
];

export const PRESETS = {
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

export const PRESET_LABELS = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
  custom: 'Custom',
};

export const PRESET_DESCRIPTIONS = {
  admin: 'Edit everything, plus manage users',
  editor: 'Edit everything except user management',
  viewer: 'Read-only access to everything',
  custom: 'Pick per-tab access',
};

const NONE_PERMS = {
  admin: 'none',
  projects: 'none', schedule: 'none', vendors: 'none',
  payapps: 'none', changeorders: 'none', documents: 'none',
};

export function normalize(obj) {
  const result = { admin: obj?.admin === 'full' ? 'full' : 'none' };
  for (const tab of TABS) {
    const v = obj?.[tab.id];
    result[tab.id] = (v === 'full' || v === 'read' || v === 'none') ? v : 'none';
  }
  return result;
}

// Returns the preset name that matches `perms` exactly, or 'custom'.
export function detectPreset(perms) {
  const norm = normalize(perms);
  for (const name of Object.keys(PRESETS)) {
    if (JSON.stringify(norm) === JSON.stringify(PRESETS[name])) return name;
  }
  return 'custom';
}

export function fromPreset(name) {
  const preset = PRESETS[name];
  return preset ? { ...preset } : null;
}

export function emptyPerms() {
  return { ...NONE_PERMS };
}

// Human-readable summary for the table row, e.g. "Editor" or "Custom · 3 tabs".
export function summarizePerms(perms) {
  const preset = detectPreset(perms);
  if (preset !== 'custom') return PRESET_LABELS[preset];
  const norm = normalize(perms);
  const tabsWithAccess = TABS.filter(t => norm[t.id] !== 'none').length;
  if (tabsWithAccess === 0) return 'Custom · no tab access';
  return `Custom · ${tabsWithAccess} tab${tabsWithAccess === 1 ? '' : 's'}`;
}

// UI helpers — call from view components to decide whether to show
// create/edit/delete buttons.
export function canEdit(me, tab) {
  if (!me) return false;
  return me.permissions?.[tab] === 'full';
}

export function canView(me, tab) {
  if (!me) return false;
  const level = me.permissions?.[tab];
  return level === 'full' || level === 'read';
}
