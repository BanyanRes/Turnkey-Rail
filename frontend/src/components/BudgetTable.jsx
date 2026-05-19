import { useState, useEffect } from 'react';
import { api } from '../api';
import { fmtMoney, parseMoney } from '../utils';

export default function BudgetTable({ projectId, onTotalsChange }) {
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const data = await api.listBudget(projectId);
      setLines(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function updateLine(id, patch) {
    const updated = await api.updateBudgetLine(id, patch);
    setLines((prev) => prev.map((l) => (l.id === id ? updated : l)));
    onTotalsChange?.();
    return updated;
  }

  async function deleteLine(id) {
    if (!confirm('Delete this budget line?')) return;
    try {
      await api.deleteBudgetLine(id);
      setLines((prev) => prev.filter((l) => l.id !== id));
      onTotalsChange?.();
    } catch (e) {
      alert(e.message);
    }
  }

  async function addLine(data) {
    const created = await api.createBudgetLine(projectId, {
      ...data,
      sort_order: lines.length,
    });
    setLines((prev) => [...prev, created]);
    setShowNew(false);
    onTotalsChange?.();
  }

  const total = lines.reduce((sum, l) => sum + Number(l.budgeted_amount || 0), 0);

  return (
    <section className="budget-section">
      <div className="section-header">
        <h3>Budget</h3>
        {!showNew && (
          <button className="btn-secondary btn-sm" onClick={() => setShowNew(true)}>
            + Add line
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : (
        <table className="budget-table">
          <thead>
            <tr>
              <th className="col-code">Code</th>
              <th className="col-cat">Category</th>
              <th>Description</th>
              <th className="col-amount">Budgeted</th>
              <th className="col-action"></th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan="5" className="muted center pad">
                  No budget lines yet.
                </td>
              </tr>
            )}
            {lines.map((l) => (
              <tr key={l.id}>
                <td className="col-code">{l.cost_code}</td>
                <td className="col-cat muted">{l.category || '—'}</td>
                <td>{l.description}</td>
                <td className="col-amount">
                  <InlineAmount
                    value={l.budgeted_amount}
                    onSave={(v) => updateLine(l.id, { budgeted_amount: v })}
                  />
                </td>
                <td className="col-action">
                  <button
                    className="btn-icon"
                    onClick={() => deleteLine(l.id)}
                    title="Delete line"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="3" className="strong">Total</td>
              <td className="col-amount strong">{fmtMoney(total)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      )}

      {showNew && (
        <NewBudgetLineForm onCreate={addLine} onCancel={() => setShowNew(false)} />
      )}
    </section>
  );
}

function InlineAmount({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? 0));
  const [saving, setSaving] = useState(false);

  function start() {
    setDraft(String(value ?? 0));
    setEditing(true);
  }

  async function commit() {
    if (saving) return;
    const parsed = parseMoney(draft);
    if (parsed === Number(value)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
      setEditing(false);
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        className="inline-input"
        type="text"
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.target.blur();
          }
          if (e.key === 'Escape') {
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <span className="inline-editable" onClick={start} title="Click to edit">
      {fmtMoney(value)}
    </span>
  );
}

function NewBudgetLineForm({ onCreate, onCancel }) {
  const [form, setForm] = useState({
    cost_code: '',
    category: '',
    description: '',
    budgeted_amount: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.cost_code.trim() || !form.description.trim()) {
      setError('Code and description are required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        cost_code: form.cost_code.trim(),
        category: form.category.trim() || null,
        description: form.description.trim(),
        budgeted_amount: parseMoney(form.budgeted_amount),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="new-line-form" onSubmit={submit}>
      <input
        placeholder="Code"
        value={form.cost_code}
        onChange={(e) => update('cost_code', e.target.value)}
        autoFocus
      />
      <input
        placeholder="Category"
        value={form.category}
        onChange={(e) => update('category', e.target.value)}
      />
      <input
        placeholder="Description"
        value={form.description}
        onChange={(e) => update('description', e.target.value)}
      />
      <input
        placeholder="Amount"
        value={form.budgeted_amount}
        onChange={(e) => update('budgeted_amount', e.target.value)}
      />
      <button type="submit" disabled={busy} className="btn-primary btn-sm">
        {busy ? '…' : 'Add'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="btn-secondary btn-sm"
      >
        Cancel
      </button>
      {error && <div className="error span-all">{error}</div>}
    </form>
  );
}
