import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { fmtMoney, parseMoney } from '../utils';
import { canEdit } from '../permissions';

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  void: 'Void',
};

const REASONS = [
  'Owner request',
  'Unforeseen condition',
  'Design change',
  'Allowance reconciliation',
  'Scope clarification',
  'Other',
];

const EMPTY = {
  project_id: '',
  subcontractor_id: '',
  description: '',
  reason: '',
  amount: '',
  days_added: 0,
  requested_date: '',
  status: 'draft',
  notes: '',
};

export default function ChangeOrdersView({ me }) {
  const editable = canEdit(me, 'changeorders');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scope, setScope] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | CO object

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listChangeOrders({ scope, status: statusFilter });
      setItems(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [scope, statusFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  // Summary totals
  const approvedTotal = items
    .filter((c) => c.status === 'approved')
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const pendingTotal = items
    .filter((c) => c.status === 'submitted' || c.status === 'draft')
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);

  async function handleSave(data) {
    if (editing === 'new') {
      await api.createChangeOrder(data);
    } else {
      await api.updateChangeOrder(editing.id, data);
    }
    setEditing(null);
    await refresh();
  }

  async function handleDelete(co) {
    if (!confirm(`Delete CO #${co.co_number} (${co.description})?`)) return;
    try {
      await api.deleteChangeOrder(co.id);
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <>
      <div className="view-toolbar">
        <div className="filter-bar">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="select-input"
          >
            <option value="">All scopes</option>
            <option value="owner">Owner-side (project)</option>
            <option value="sub">Sub-side (vendor)</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="select-input"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="void">Void</option>
          </select>
        </div>
        {editable && <button className="btn-primary" onClick={() => setEditing('new')}>+ New Change Order</button>}
      </div>

      <main className="vendors-main">
        <div className="co-summary">
          <div className="co-summary-item">
            <div className="label">Approved</div>
            <div className="amount-cell strong">{fmtMoney(approvedTotal)}</div>
          </div>
          <div className="co-summary-item">
            <div className="label">Pending (draft + submitted)</div>
            <div className="amount-cell">{fmtMoney(pendingTotal)}</div>
          </div>
          <div className="co-summary-item">
            <div className="label">Count</div>
            <div className="amount-cell">{items.length}</div>
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        {loading ? (
          <div className="muted">Loading…</div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            {scope || statusFilter
              ? 'No change orders match your filters.'
              : 'No change orders yet. Click "+ New Change Order" to create one.'}
          </div>
        ) : (
          <table className="vendors-table">
            <thead>
              <tr>
                <th style={{ width: 70 }}>#</th>
                <th>Project</th>
                <th>Scope</th>
                <th>Description</th>
                <th>Reason</th>
                <th>Requested</th>
                <th>Status</th>
                <th className="amount-th">Amount</th>
                <th className="amount-th">Days</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="vendor-row" onClick={() => editable && setEditing(c)} style={{ cursor: editable ? 'pointer' : 'default' }}>
                  <td className="strong">CO-{String(c.co_number).padStart(3, '0')}</td>
                  <td>
                    <span className="code">{c.project_code}</span>{' '}
                    <span className="muted">— {c.project_name}</span>
                  </td>
                  <td>
                    {c.subcontractor_name ? (
                      <span className="scope-pill scope-sub">{c.subcontractor_name}</span>
                    ) : (
                      <span className="scope-pill scope-owner">Owner</span>
                    )}
                  </td>
                  <td>{c.description}</td>
                  <td className="muted">{c.reason || '—'}</td>
                  <td className="muted">{c.requested_date || '—'}</td>
                  <td>
                    <span className={`status status-${c.status}`}>
                      {STATUS_LABELS[c.status] || c.status}
                    </span>
                  </td>
                  <td className={`amount-cell strong ${Number(c.amount) < 0 ? 'cell-bad' : ''}`}>
                    {fmtMoney(c.amount)}
                  </td>
                  <td className="amount-cell muted">{c.days_added || 0}</td>
                  <td className="col-action" onClick={(e) => e.stopPropagation()}>
                    {editable && <button className="btn-icon" title="Delete" onClick={() => handleDelete(c)}>×</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>

      {editing && (
        <ChangeOrderForm
          initial={editing === 'new' ? EMPTY : editing}
          isNew={editing === 'new'}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ChangeOrderForm({ initial, isNew, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial, amount: initial.amount ?? '' });
  const [projects, setProjects] = useState([]);
  const [subs, setSubs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.listProjects(), api.listSubs({ status: 'active' })])
      .then(([ps, ss]) => { setProjects(ps); setSubs(ss); })
      .catch((e) => setError(e.message));
  }, []);

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.project_id) return setError('Project is required');
    if (!form.description.trim()) return setError('Description is required');

    setBusy(true);
    setError(null);
    try {
      const payload = {
        project_id: Number(form.project_id),
        subcontractor_id: form.subcontractor_id ? Number(form.subcontractor_id) : null,
        description: form.description.trim(),
        reason: form.reason || null,
        amount: parseMoney(form.amount),
        days_added: Number(form.days_added) || 0,
        requested_date: form.requested_date || null,
        status: form.status,
        notes: form.notes || null,
      };
      if (!isNew && 'approved_date' in initial) {
        // preserve approved_date unless backend auto-stamps it
      }
      await onSave(payload);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>
          {isNew ? 'New Change Order' : `Edit CO-${String(initial.co_number).padStart(3, '0')}`}
        </h2>

        <div className="row-2">
          <label>
            Project *
            <select
              value={form.project_id}
              onChange={(e) => update('project_id', e.target.value)}
              autoFocus
              disabled={!isNew}
            >
              <option value="">— Select a project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </select>
          </label>
          <label>
            Scope
            <select
              value={form.subcontractor_id}
              onChange={(e) => update('subcontractor_id', e.target.value)}
              disabled={!isNew}
            >
              <option value="">Owner-side (affects project contract)</option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  Sub: {s.name}{s.trade ? ` (${s.trade})` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label>
          Description *
          <input
            value={form.description}
            onChange={(e) => update('description', e.target.value)}
            placeholder="Add ADU foundation"
          />
        </label>

        <div className="row-2">
          <label>
            Reason
            <select
              value={form.reason || ''}
              onChange={(e) => update('reason', e.target.value)}
            >
              <option value="">—</option>
              {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label>
            Requested date
            <input
              type="date"
              value={form.requested_date || ''}
              onChange={(e) => update('requested_date', e.target.value)}
            />
          </label>
        </div>

        <div className="row-2">
          <label>
            Amount (negative = deduct)
            <input
              value={form.amount}
              onChange={(e) => update('amount', e.target.value)}
              placeholder="e.g. 12500 or -3000"
            />
          </label>
          <label>
            Days added (schedule impact)
            <input
              type="number"
              value={form.days_added}
              onChange={(e) => update('days_added', e.target.value)}
            />
          </label>
        </div>

        <label>
          Status
          <select
            value={form.status}
            onChange={(e) => update('status', e.target.value)}
          >
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="void">Void</option>
          </select>
        </label>

        <label>
          Notes
          <textarea
            rows="3"
            value={form.notes || ''}
            onChange={(e) => update('notes', e.target.value)}
          />
        </label>

        {!isNew && initial.approved_date && (
          <div className="muted" style={{ fontSize: 12 }}>
            Approved on {initial.approved_date}
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onCancel} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : (isNew ? 'Create' : 'Save changes')}
          </button>
        </div>
      </form>
    </div>
  );
}
