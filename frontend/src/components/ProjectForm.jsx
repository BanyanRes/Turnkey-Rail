import { useState } from 'react';
import { parseMoney } from '../utils';

// Dual-mode project form. When `project` is passed it edits that project
// (PATCH); otherwise it creates a new one (POST). The parent supplies the
// async `onSubmit(data)` handler and `onCancel`.
export default function ProjectForm({ project, onSubmit, onCancel }) {
  const isEdit = !!project;
  const [form, setForm] = useState({
    name: project?.name ?? '',
    owner_name: project?.owner_name ?? '',
    address: project?.address ?? '',
    contract_amount:
      project?.contract_amount != null ? String(project.contract_amount) : '',
    start_date: project?.start_date ?? '',
    end_date: project?.end_date ?? '',
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
      await onSubmit({
        name: form.name.trim(),
        owner_name: form.owner_name.trim() || null,
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
        <h2>{isEdit ? `Edit Project ${project.code}` : 'New Project'}</h2>

        {!isEdit && (
          <p className="form-hint" style={{ fontSize: '12px', color: '#64748b', margin: '0 0 4px' }}>
            A project number (e.g. 0001) is assigned automatically.
          </p>
        )}

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
          Owner name
          <input
            value={form.owner_name}
            onChange={(e) => update('owner_name', e.target.value)}
            placeholder="CLR Buna Property Owner"
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
            {busy ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save' : 'Create')}
          </button>
        </div>
      </form>
    </div>
  );
}
