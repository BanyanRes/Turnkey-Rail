// =====================================================================
// CloudLedger HTTP client for Turnkey Rail
// ---------------------------------------------------------------------
// Talks to CloudLedger's /api/turnkey/* endpoints using an API key.
// Failures are logged but never block Turnkey's primary operation
// (you can still approve a pay app even if CL is down); the sync can
// be retried later via the admin "Resync to CloudLedger" action.
//
// Configuration via env vars:
//   CLOUDLEDGER_URL      e.g. http://localhost:3001  (no trailing slash)
//   CLOUDLEDGER_API_KEY  the tkr_... key issued by CL admin
//   CLOUDLEDGER_ENABLED  '1' to turn the integration on (default off)
// =====================================================================

const BASE = (process.env.CLOUDLEDGER_URL || '').replace(/\/$/, '');
const KEY  = process.env.CLOUDLEDGER_API_KEY || '';
const ENABLED = process.env.CLOUDLEDGER_ENABLED === '1';

function isEnabled() {
  return ENABLED && !!BASE && !!KEY;
}

// Generic POST. Returns the parsed JSON body. Throws on any non-2xx.
async function clPost(path, body) {
  if (!isEnabled()) {
    throw new Error('CloudLedger integration disabled (set CLOUDLEDGER_ENABLED=1, _URL, _API_KEY)');
  }
  const url = BASE + path;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    throw new Error('CL POST ' + path + ' HTTP ' + resp.status + ': ' + (data.error || text.slice(0, 200)));
  }
  return data;
}

async function clGet(path) {
  if (!isEnabled()) {
    throw new Error('CloudLedger integration disabled');
  }
  const resp = await fetch(BASE + path, {
    headers: { 'Authorization': 'Bearer ' + KEY, 'Accept': 'application/json' },
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    throw new Error('CL GET ' + path + ' HTTP ' + resp.status + ': ' + (data.error || text.slice(0, 200)));
  }
  return data;
}

// ---------- Public sync surface ----------

// Link a Turnkey project to a CloudLedger entity (idempotent on CL side).
async function linkProject({ turnkey_project_id, project_code, project_name, contract_amount, total_estimated_costs }) {
  return clPost('/api/turnkey/projects/link', { turnkey_project_id, project_code, project_name, contract_amount, total_estimated_costs });
}

async function getProjectMap(turnkey_project_id) {
  return clGet('/api/turnkey/projects/' + turnkey_project_id);
}

async function syncSubPayAppApproved(payload) {
  return clPost('/api/turnkey/sync/sub-payapp-approved', payload);
}

async function syncSubPayAppPaid(payload) {
  return clPost('/api/turnkey/sync/sub-payapp-paid', payload);
}

async function syncOwnerPayAppIssued(payload) {
  return clPost('/api/turnkey/sync/owner-payapp-issued', payload);
}

async function syncOwnerPaymentReceived(payload) {
  return clPost('/api/turnkey/sync/owner-payment-received', payload);
}

async function syncMonthEndPOC(payload) {
  return clPost('/api/turnkey/sync/month-end-poc', payload);
}

// ---------- Safe wrapper: log + swallow errors ----------
// Use this when sync failure should NOT abort the Turnkey operation.
// Returns { ok, result } or { ok: false, error }.
async function trySync(label, fn) {
  if (!isEnabled()) {
    return { ok: false, skipped: true, reason: 'integration disabled' };
  }
  try {
    const result = await fn();
    console.log('[cloudledger] ' + label + ' OK: ' + JSON.stringify(result));
    return { ok: true, result };
  } catch (e) {
    console.error('[cloudledger] ' + label + ' FAILED: ' + e.message);
    return { ok: false, error: e.message };
  }
}

// WIP schedule (JSON)
async function getWipScheduleJson(asOfDate) {
  const qs = asOfDate ? ('?as_of=' + encodeURIComponent(asOfDate)) : '';
  return clGet('/api/turnkey/wip-schedule' + qs);
}

// Direct (non-commitment) costs for a project, grouped by cost code.
// CloudLedger returns actual GL costs posted to the project that are NOT
// subcontractor commitment billings (those come from Turnkey pay apps).
// Expected shape:
//   { as_of, project_id, lines: [{ cost_code, amount }], total }
// The Cost Report calls this best-effort: if CL is disabled/unreachable or the
// endpoint isn't live yet, Direct Costs simply show as 0 and the rest of the
// report still renders.
async function getDirectCosts(turnkeyProjectId, asOfDate) {
  const qs = asOfDate ? ('?as_of=' + encodeURIComponent(asOfDate)) : '';
  return clGet('/api/turnkey/projects/' + turnkeyProjectId + '/direct-costs' + qs);
}

// Returns the Excel buffer for download passthrough (Turnkey wraps this in a route)
async function getWipScheduleXlsxBuffer(asOfDate) {
  if (!isEnabled()) throw new Error('CloudLedger integration disabled');
  const qs = asOfDate ? ('?as_of=' + encodeURIComponent(asOfDate)) : '';
  const resp = await fetch(BASE + '/api/turnkey/wip-schedule.xlsx' + qs, {
    headers: { 'Authorization': 'Bearer ' + KEY },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('CL WIP xlsx HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  return Buffer.from(await resp.arrayBuffer());
}

module.exports = {
  isEnabled,
  linkProject,
  getProjectMap,
  syncSubPayAppApproved,
  syncSubPayAppPaid,
  syncOwnerPayAppIssued,
  syncOwnerPaymentReceived,
  syncMonthEndPOC,
  trySync,
  getWipScheduleJson,
  getWipScheduleXlsxBuffer,
  getDirectCosts,
};
