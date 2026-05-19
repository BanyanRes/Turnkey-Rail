import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

const EMPTY = {
  name: '', trade: '', contact_name: '', email: '', phone: '',
  address: '', license_number: '', tax_id: '',
  insurance_expiry: '', status: 'active', notes: '',
};

export default function VendorsView() {
  const [subs, setSubs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | sub object

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const data = await api.listSubs({ q: query, status: statusFilter });
      setSubs(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [query, statusFilter]);

  useEffect(() => {
    const t = setTimeout(refresh, 200); // debounce search
    return () => clearTimeout(t);
  }, [refresh]);

  async function handleSave(data) {
    if (editing === 'new') {
      await api.createSub(data);
    } else {
      await api.updateSub(editing.id, data);
    }
    setEditing(null);
    await refresh();
  }

  async function handleDelete(sub) {
    if (!confirm(`Delete vendor "${sub.name}"?`)) return;
    try {
      await api.deleteSub(sub.id);
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <>
      <div className="view-toolbar">
        <div className="filter-bar">
          <input
            type="search"
            className="search-input"
            placeholder="Search vendors…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="select-input"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <button className="btn-primary" onClick={() => setEditing('new')}>+ New Vendor</button>
      </div>

      <main className="vendors-main">
        {error && <div className="error">{error}</div>}
        {loading ? (
          <div className="muted">Loading…</div>
        ) : subs.length === 0 ? (
          <div className="empty-state">
            {query || statusFilter
              ? 'No vendors match your filters.'
              : 'No vendors yet. Click "+ New Vendor" to add your first.'}
          </div>
        ) : (
          <table className="vendors-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Trade</th>
                <th>Contact</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Ins. expires</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} onClick={() => setEditing(s)} className="vendor-row">
                  <td className="strong">{s.name}</td>
                  <td className="muted">{s.trade || '—'}</td>
                  <td>{s.contact_name || '—'}</td>
                  <td>{s.email || '—'}</td>
                  <td>{s.phone || '—'}</td>
                  <td className={insuranceClass(s.insurance_expiry)}>
                    {s.insurance_expiry || '—'}
                  </td>
                  <td>
                    <span className={`status status-${s.status}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="col-action" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn-icon"
                      title="Delete vendor"
                      onClick={() => handleDelete(s)}
                    >×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>

      {editing && (
        <VendorForm
          initial={editing === 'new' ? EMPTY : editing}
          isNew={editing === 'new'}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </>
  );
}

function insuranceClass(date) {
  if (!date) return 'muted';
  const expiry = new Date(date);
  const now = new Date();
  const days = (expiry - now) / 86400000;
  if (days < 0) return 'cell-bad';
  if (days < 30) return 'cell-warn';
  return '';
}

function VendorForm({ initial, isNew, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Normalize: empty strings -> null so DB stays clean
      const payload = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [
          k, typeof v === 'string' && v.trim() === '' ? null : v,
        ])
      );
      payload.name = form.name.trim();
      await onSave(payload);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal modal-wide"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>{isNew ? 'New Vendor' : 'Edit Vendor'}</h2>

        <div className="row-2">
          <label>
            Name *
            <input
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              autoFocus
              placeholder="ABC Framing Inc."
            />
          </label>
          <label>
            Trade
            <input
              value={form.trade || ''}
              onChange={(e) => update('trade', e.target.value)}
              placeholder="Framing"
            />
          </label>
        </div>

        <div className="row-2">
          <label>
            Contact name
            <input
              value={form.contact_name || ''}
              onChange={(e) => update('contact_name', e.target.value)}
            />
          </label>
          <label>
            Phone
            <input
              value={form.phone || ''}
              onChange={(e) => update('phone', e.target.value)}
              placeholder="(555) 555-1234"
            />
          </label>
        </div>

        <label>
          Email
          <input
            type="email"
            value={form.email || ''}
            onChange={(e) => update('email', e.target.value)}
          />
        </label>

        <label>
          Address
          <input
            value={form.address || ''}
            onChange={(e) => update('address', e.target.value)}
          />
        </label>

        <div className="row-2">
          <label>
            License #
            <input
              value={form.license_number || ''}
              onChange={(e) => update('license_number', e.target.value)}
            />
          </label>
          <label>
            Tax ID
            <input
              value={form.tax_id || ''}
              onChange={(e) => update('tax_id', e.target.value)}
              placeholder="EIN or last-4 SSN"
            />
          </label>
        </div>

        <div className="row-2">
          <label>
            Insurance expires
            <input
              type="date"
              value={form.insurance_expiry || ''}
              onChange={(e) => update('insurance_expiry', e.target.value)}
            />
          </label>
          <label>
            Status
            <select
              value={form.status}
              onChange={(e) => update('status', e.target.value)}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        </div>

        <label>
          Notes
          <textarea
            rows="3"
            value={form.notes || ''}
            onChange={(e) => update('notes', e.target.value)}
          />
        </label>

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
