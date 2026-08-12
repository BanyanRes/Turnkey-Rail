// Tiny fetch wrapper. All requests are JSON in/out.
const BASE = '/api';

// Optional 401 handler — App.jsx registers this on mount so we can redirect
// to the login screen when a session expires mid-use.
let on401Handler = null;
export function setOn401Handler(fn) {
  on401Handler = fn;
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include', // send/receive session cookie
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && on401Handler) {
      // Don't trigger the redirect for the login call itself — it's expected
      // to return 401 on bad credentials and the caller handles that.
      if (path !== '/login') {
        on401Handler();
      }
    }
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  // Projects
  listProjects: () => request('/projects'),
  getProject: (id) => request(`/projects/${id}`),
  getProjectReconciliation: (id, period) => {
    const qs = period ? `?period=${encodeURIComponent(period)}` : '';
    return request(`/projects/${id}/reconciliation${qs}`);
  },
  createProject: (data) =>
    request('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id, data) =>
    request(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),

  // Budget (project-nested)
  listBudget: (projectId) => request(`/projects/${projectId}/budget`),
  createBudgetLine: (projectId, data) =>
    request(`/projects/${projectId}/budget`, { method: 'POST', body: JSON.stringify(data) }),
  bulkBudget: (projectId, lines) =>
    request(`/projects/${projectId}/budget/bulk`, {
      method: 'POST', body: JSON.stringify({ lines }),
    }),

  // Budget lines (flat)
  updateBudgetLine: (id, data) =>
    request(`/budget-lines/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBudgetLine: (id) =>
    request(`/budget-lines/${id}`, { method: 'DELETE' }),

  // Cost Report — the mirrored "Summary" report for a project.
  getCostReport: (projectId, asOf) => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    return request(`/projects/${projectId}/cost-report${qs}`);
  },

  // Budget Modifications / Allocations
  listBudgetMods: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return request(`/budget-modifications${q ? `?${q}` : ''}`);
  },
  createBudgetMod: (data) =>
    request('/budget-modifications', { method: 'POST', body: JSON.stringify(data) }),
  updateBudgetMod: (id, data) =>
    request(`/budget-modifications/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBudgetMod: (id) =>
    request(`/budget-modifications/${id}`, { method: 'DELETE' }),

  // Subcontractors
  listSubs: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return request(`/subcontractors${q ? `?${q}` : ''}`);
  },
  getSub: (id) => request(`/subcontractors/${id}`),
  createSub: (data) =>
    request('/subcontractors', { method: 'POST', body: JSON.stringify(data) }),
  updateSub: (id, data) =>
    request(`/subcontractors/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSub: (id) =>
    request(`/subcontractors/${id}`, { method: 'DELETE' }),

  // Pay applications
  listPayApps: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return request(`/pay-apps${q ? `?${q}` : ''}`);
  },
  getPayApp: (id) => request(`/pay-apps/${id}`),
  createPayApp: (data) =>
    request('/pay-apps', { method: 'POST', body: JSON.stringify(data) }),
  // Start the next pay-app cycle for a project (or owner-side: subcontractor_id=null).
  // Copies the prior pay app's line items with totals rolled forward, or seeds from
  // budget lines if no prior pay app exists.
  autoCreatePayApp: ({ project_id, subcontractor_id = null }) =>
    request('/pay-apps/auto-create', {
      method: 'POST',
      body: JSON.stringify({ project_id, subcontractor_id }),
    }),
  updatePayApp: (id, data) =>
    request(`/pay-apps/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deletePayApp: (id) =>
    request(`/pay-apps/${id}`, { method: 'DELETE' }),
  // Re-pull the approved-change-order total for an existing pay app and store
  // it on the header. Returns the updated pay app with computed totals.
  refreshChangeOrders: (id) =>
    request(`/pay-apps/${id}/refresh-change-orders`, { method: 'POST' }),
  // Returns a URL the browser can open/download to get the AIA G702/G703 PDF.
  // download=true forces an attachment; otherwise the PDF opens inline.
  payAppPdfUrl: (id, { download = false } = {}) =>
    `/api/pay-apps/${id}/pdf${download ? '?download=1' : ''}`,
  // Schedule of Values Excel import/export. Template download is a URL the
  // browser opens directly; import is multipart so we hit fetch by hand.
  sovTemplateUrl: (id) => `/api/pay-apps/${id}/sov-template`,
  importSov: async (id, file, mode = 'replace') => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/pay-apps/${id}/sov-import?mode=${mode}`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  },
  // Variance / anomaly alerts for a pay app (over-budget lines, big jumps,
  // sub overbilled vs contract, project margin negative). Read-only.
  getPayAppAlerts: (id) => request(`/pay-apps/${id}/alerts`),

  // Pay app lines
  listPayAppLines: (payAppId) => request(`/pay-apps/${payAppId}/lines`),
  createPayAppLine: (payAppId, data) =>
    request(`/pay-apps/${payAppId}/lines`, { method: 'POST', body: JSON.stringify(data) }),
  updatePayAppLine: (id, data) =>
    request(`/pay-app-lines/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deletePayAppLine: (id) =>
    request(`/pay-app-lines/${id}`, { method: 'DELETE' }),

  // Change orders
  listChangeOrders: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return request(`/change-orders${q ? `?${q}` : ''}`);
  },
  getChangeOrder: (id) => request(`/change-orders/${id}`),
  createChangeOrder: (data) =>
    request('/change-orders', { method: 'POST', body: JSON.stringify(data) }),
  updateChangeOrder: (id, data) =>
    request(`/change-orders/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteChangeOrder: (id) =>
    request(`/change-orders/${id}`, { method: 'DELETE' }),

  // Documents (file upload uses multipart, not JSON)
  listDocuments: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return request(`/documents${q ? `?${q}` : ''}`);
  },
  // Upload a file. pay_app_id options:
  //   undefined  → server auto-attaches to the active Owner draft pay app (if any)
  //   number     → explicit attach to that pay app
  //   'none'     → opt out of auto-attach, leave the doc project-scoped only
  uploadDocument: async ({ file, project_id, pay_app_id, category, notes }) => {
    const fd = new FormData();
    fd.append('file', file);
    if (project_id) fd.append('project_id', project_id);
    if (pay_app_id != null) fd.append('pay_app_id', String(pay_app_id));
    if (category) fd.append('category', category);
    if (notes) fd.append('notes', notes);
    const res = await fetch('/api/documents', { method: 'POST', body: fd, credentials: 'include' });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  },
  updateDocument: (id, data) =>
    request(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDocument: (id) =>
    request(`/documents/${id}`, { method: 'DELETE' }),
  documentUrl: (id, { download = false } = {}) =>
    `/api/documents/${id}/download${download ? '?download=1' : ''}`,

  // Lien waivers (both inbound from subs and outbound to owner)
  listLienWaivers: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return request(`/lien-waivers${q ? `?${q}` : ''}`);
  },
  getLienWaiver: (id) => request(`/lien-waivers/${id}`),
  createLienWaiver: (data) =>
    request('/lien-waivers', { method: 'POST', body: JSON.stringify(data) }),
  updateLienWaiver: (id, data) =>
    request(`/lien-waivers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteLienWaiver: (id) =>
    request(`/lien-waivers/${id}`, { method: 'DELETE' }),
  getLienWaiverWarnings: () => request('/lien-waivers/warnings'),

  // Schedule tasks
  listTasks: (projectId) => request(`/tasks?project_id=${projectId}`),
  createTask: (data) =>
    request('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id, data) =>
    request(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTask: (id) =>
    request(`/tasks/${id}`, { method: 'DELETE' }),

  // Current user
  getMe: () => request('/me'),

  // Authentication
  login: ({ username, password, rememberMe }) =>
    request('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, rememberMe }),
    }),
  logout: () => request('/logout', { method: 'POST' }),

  // Users (admin only)
  listUsers: () => request('/users'),
  createUser: (data) =>
    request('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id, data) =>
    request(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id) =>
    request(`/users/${id}`, { method: 'DELETE' }),

  // Invitations (admin only, except the two /token/ endpoints which are public)
  listInvitations: () => request('/invitations'),
  createInvitation: (data) =>
    request('/invitations', { method: 'POST', body: JSON.stringify(data) }),
  deleteInvitation: (id) =>
    request(`/invitations/${id}`, { method: 'DELETE' }),
  // Public — used by the invite-accept page
  getInvitationByToken: (token) => request(`/invitations/token/${token}`),
  acceptInvitation: (token, data) =>
    request(`/invitations/token/${token}/accept`, { method: 'POST', body: JSON.stringify(data) }),
};
