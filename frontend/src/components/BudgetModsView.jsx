import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { fmtMoney, parseMoney } from '../utils';
import { canEdit } from '../permissions';

// Budget Modifications / Allocations tab.
//
// Dev managers log budget changes per project here: reallocations between cost
// codes, contingency draws, owner-funded increases. Each row is a SIGNED dollar
// change tied to a cost code. The net of APPROVED rows is what rolls up into the
// "Budget Modifications" column of that project's Cost Report (Projects tab).
const KINDS = [
  { id: 'modification', label: 'Modification' },
  { id: 'allocation', label: 'Reallocation' },
  { id: 'contingency', label: 'Contingency draw' },
  { id: 'owner_funded', label: 'Owner-funded' },
];

const EMPTY = {
  cost_code: '', category: '', description: '', amount: '',
  kind: 'modification', status: 'approved', mod_date: '', notes: '',
};

export default function BudgetModsView({ me }) {
  const editable = canEdit(me, 'projects');
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [rows, setRows] = useState([]);
  const [budgetLines, setBudgetLines] = useState([]);
  const [summary, setSummary] = useState({ approved_total: 0, draft_total: 0, count: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const ps = await api.listProjects();
        setProjects(ps);
        setProjectId((prev) => prev ?? ps[0]?.id ?? null);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!projectId) { setRows([]); setLoading(false); return; }
    try {
      setError(null);
      setLoading(true);
      const data = await api.listBudgetMods({ project_id: projectId });
      setRows(data.rows || []);
      setSummary(data.summary || { approved_total: 0, draft_total: 0, count: 0 });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Load the project's budget lines to drive the cost-code dropdown.
  useEffect(() => {
    if (!projectId) { setBudgetLines([]); return; }
    let cancelled = false;
    api.listBudget(projectId)
      .then((r) => { if (!cancelled) setBudgetLines(r); })
      .catch(() => { if (!cancelled) setBudgetLines([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  // De-duplicate cost codes; remember each code's category so picking a code can
  // auto-fill the category column.
  const costCodeOptions = [];
  const seenCodes = new Set();
  const catByCode = {};
  for (const b of budgetLines) {
    const code = (b.cost_code || '').trim();
    if (!code) continue;
    if (!(code in catByCode)) catByCode[code] = b.category || '';
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);
    costCodeOptions.push({ code, description: b.description || '' });
  }

  function pickCostCode(code) {
    setForm((f) => ({ ...f, cost_code: code, category: catByCode[code] || f.category }));
  }

  function resetForm() { setForm(EMPTY); setEditingId(null); }

  async function submit(e) {
    e.preventDefault();
    if (!form.cost_code.trim() || !form.description.trim()) {
      setError('Cost code and description are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        project_id: projectId,
        cost_code: form.cost_code.trim(),
        category: form.category.trim() || null,
        description: form.description.trim(),
        amount: parseMoney(form.amount),
        kind: form.kind,
        status: form.status,
        mod_date: form.mod_date || null,
        notes: form.notes.trim() || null,
      };
      if (editingId) await api.updateBudgetMod(editingId, payload);
      else await api.createBudgetMod(payload);
      resetForm();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function startEdit(row) {
    setEditingId(row.id);
    setForm({
      cost_code: row.cost_code || '',
      category: row.category || '',
      description: row.description || '',
      amount: String(row.amount ?? ''),
      kind: row.kind || 'modification',
      status: row.status || 'approved',
      mod_date: row.mod_date || '',
      notes: row.notes || '',
    });
  }

  async function remove(row) {
    if (!confirm(`Delete this budget modification (${row.description})?`)) return;
    try {
      await api.deleteBudgetMod(row.id);
      if (editingId === row.id) resetForm();
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  const selectedProject = projects.find((p) => p.id === projectId) || null;

  return (
    <div className="budget-mods-view" style={{ padding: '4px 0' }}>
      <div className="view-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ fontWeight: 600 }}>Project</label>
        <select
          value={projectId ?? ''}
          onChange={(e) => setProjectId(Number(e.target.value))}
          style={{ padding: '6px 8px', minWidth: 260 }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
          ))}
        </select>
        {selectedProject && (
          <div className="muted" style={{ marginLeft: 'auto', display: 'flex', gap: 18 }}>
            <span>Rolls into report: <strong className={summary.approved_total < 0 ? 'cell-bad' : ''}>
              {fmtMoney(summary.approved_total)}</strong></span>
            {summary.draft_total !== 0 && (
              <span>Draft (excluded): {fmtMoney(summary.draft_total)}</span>
            )}
          </div>
        )}
      </div>

      <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
        Each row is a signed change to a cost code&apos;s budget. Positive adds budget,
        negative pulls it. A pure reallocation is two rows (a minus on the source
        code, a plus on the destination) that net to zero. Only <strong>approved</strong>
        rows feed the Cost Report&apos;s Budget Modifications column.
      </p>

      {error && <div className="cell-bad" style={{ margin: '8px 0' }}>{error}</div>}

      {editable && (
        <form onSubmit={submit} className="bm-form" style={bmForm}>
          <select value={form.cost_code} onChange={(e) => pickCostCode(e.target.value)}
            style={{ width: 210 }} title="Cost code (from this project's budget)">
            <option value="">Cost code *</option>
            {costCodeOptions.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}{c.description ? ` — ${c.description}` : ''}
              </option>
            ))}
            {form.cost_code && !seenCodes.has(form.cost_code) && (
              <option value={form.cost_code}>{form.cost_code}</option>
            )}
          </select>
          <input placeholder="Category" value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ width: 130 }} />
          <input placeholder="Description *" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
          <input placeholder="Amount (+/-)" value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })} style={{ width: 110, textAlign: 'right' }} />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="approved">Approved</option>
            <option value="draft">Draft</option>
          </select>
          <input type="date" value={form.mod_date}
            onChange={(e) => setForm({ ...form, mod_date: e.target.value })} />
          <button className="btn-primary" disabled={saving}>
            {editingId ? 'Save' : 'Add'}
          </button>
          {editingId && (
            <button type="button" className="btn-secondary" onClick={resetForm}>Cancel</button>
          )}
        </form>
      )}

      {loading ? (
        <div className="muted" style={{ marginTop: 12 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty" style={{ marginTop: 12 }}>No budget modifications yet for this project.</div>
      ) : (
        <table className="bm-table" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #e5e7eb' }}>
              <th style={cell}>Date</th>
              <th style={cell}>Cost code</th>
              <th style={cell}>Category</th>
              <th style={cell}>Description</th>
              <th style={cell}>Type</th>
              <th style={{ ...cell, textAlign: 'right' }}>Amount</th>
              <th style={cell}>Status</th>
              {editable && <th style={cell}></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={cell}>{r.mod_date || '—'}</td>
                <td style={cell}>{r.cost_code}</td>
                <td style={cell}>{r.category || '—'}</td>
                <td style={cell}>{r.description}</td>
                <td style={cell}>{(KINDS.find((k) => k.id === r.kind) || {}).label || r.kind}</td>
                <td style={{ ...cell, textAlign: 'right' }} className={Number(r.amount) < 0 ? 'cell-bad' : ''}>
                  {fmtMoney(r.amount)}
                </td>
                <td style={cell}>
                  <span className={`status status-${r.status === 'approved' ? 'active' : 'on_hold'}`}>{r.status}</span>
                </td>
                {editable && (
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn-secondary" onClick={() => startEdit(r)} style={{ marginRight: 6 }}>Edit</button>
                    <button className="btn-danger" onClick={() => remove(r)}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700, borderTop: '2px solid #e5e7eb' }}>
              <td style={cell} colSpan={5}>Net approved (into report)</td>
              <td style={{ ...cell, textAlign: 'right' }} className={summary.approved_total < 0 ? 'cell-bad' : ''}>
                {fmtMoney(summary.approved_total)}
              </td>
              <td style={cell} colSpan={editable ? 2 : 1}></td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

const bmForm = {
  display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
  padding: 12, background: '#f9fafb', border: '1px solid #e5e7eb',
  borderRadius: 8, marginTop: 12,
};
const cell = { padding: '6px 10px', verticalAlign: 'top' };
