// Tiny fetch wrapper. All requests are JSON in/out.
const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  // Projects
  listProjects: () => request('/projects'),
  getProject: (id) => request(`/projects/${id}`),
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
  updatePayApp: (id, data) =>
    request(`/pay-apps/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deletePayApp: (id) =>
    request(`/pay-apps/${id}`, { method: 'DELETE' }),

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
  uploadDocument: async ({ file, project_id, category, notes }) => {
    const fd = new FormData();
    fd.append('file', file);
    if (project_id) fd.append('project_id', project_id);
    if (category) fd.append('category', category);
    if (notes) fd.append('notes', notes);
    const res = await fetch('/api/documents', { method: 'POST', body: fd });
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
