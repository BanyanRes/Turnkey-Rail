import { useState } from 'react';
import { parseMoney } from '../utils';

export default function NewProjectForm({ onCreate, onCancel }) {
  const [form, setForm] = useState({
    name: '',
    address: '',
    contract_amount: '',
    start_date: '',
    end_date: '',
  });
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
      await onCreate({
        name: form.name.trim(),
        address: form.address.trim() || null,
        contract_amount: form.contract_amount ? parseMoney(form.contract_amount) : null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
      });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New Project</h2>

        <p className="form-hint" style={{ fontSize: '12px', color: '#64748b', margin: '0 0 4px' }}>
          A project number (e.g. 0001) is assigned automatically.
        </p>

        <label>
          Name *
          <input
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="Sunset Residence"
            autoFocus
          />
        </label>

        <label>
          Address
          <input
            value={form.address}
            onChange={(e) => update('address', e.target.value)}
            placeholder="123 Main St, Los Angeles, CA"
          />
        </label>

        <label>
          Contract amount
          <input
            value={form.contract_amount}
            onChange={(e) => update('contract_amount', e.target.value)}
            placeholder="0"
          />
        </label>

        <div className="row-2">
          <label>
            Start date
            <input
              type="date"
              value={form.start_date}
              onChange={(e) => update('start_date', e.target.value)}
            />
          </label>
          <label>
            End date
            <input
              type="date"
              value={form.end_date}
              onChange={(e) => update('end_date', e.target.value)}
            />
          </label>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onCancel} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
