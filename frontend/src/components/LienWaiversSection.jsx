// LienWaiversSection — embeddable list of lien waivers for a given context.
//
// Used inside PayAppDetail (filtered by pay_app_id) for now. Will be reused
// in the standalone Liens tab (Phase 3) with broader filters.
//
// Props:
//   - payApp:    pay-app row (for inbound waiver context: project_id, subcontractor_id)
//   - editable:  bool — show add/edit/delete UI
//
// Direction is currently fixed to 'inbound' here because pay apps are sub-side
// (sub → us). Outbound (us → owner) waivers will be managed from the standalone
// Liens tab where they're not tied to a sub pay app.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { fmtMoney, parseMoney } from '../utils';

const WAIVER_TYPES = [
  { id: 'conditional_progress',   label: 'Conditional · Progress' },
  { id: 'unconditional_progress', label: 'Unconditional · Progress' },
  { id: 'conditional_final',      label: 'Conditional · Final' },
  { id: 'unconditional_final',    label: 'Unconditional · Final' },
];

const TYPE_LABEL = Object.fromEntries(WAIVER_TYPES.map(t => [t.id, t.label]));

export default function LienWaiversSection({ payApp, editable = true }) {
  const [waivers, setWaivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(async () => {
    if (!payApp?.id) return;
    setLoading(true);
    try {
      const data = await api.listLienWaivers({ pay_app_id: payApp.id });
      setWaivers(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [payApp?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleCreate(data) {
    await api.createLienWaiver({
      direction: 'inbound',
      project_id: payApp.project_id,
      subcontractor_id: payApp.subcontractor_id,
      pay_app_id: payApp.id,
      ...data,
    });
    setShowNew(false);
    await refresh();
  }

  async function handleDelete(w) {
    if (!confirm(`Delete this ${TYPE_LABEL[w.waiver_type] || w.waiver_type} waiver?`)) return;
    try {
      await api.deleteLienWaiver(w.id);
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  // Show one row per waiver type so the user can see at a glance what's
  // present and what's missing for this pay app.
  const byType = Object.fromEntries(waivers.map(w => [w.waiver_type, w]));

  return (
    <section className="lien-section" style={{ marginTop: 24 }}>
      <div className="section-header">
        <h3>Lien Waivers</h3>
        {editable && !showNew && (
          <button className="btn-secondary btn-sm" onClick={() => setShowNew(true)}>
            + Record waiver
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : (
        <table className="vendors-table">
          <thead>
            <tr>
              <th>Type</th>
              <th className="amount-th">Amount</th>
              <th>Through</th>
              <th>Signed</th>
              <th>PDF</th>
              <th>Notes</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {WAIVER_TYPES.map((t) => {
              const w = byType[t.id];
              if (!w) {
                return (
                  <tr key={t.id} className="lien-row-missing">
                    <td>{t.label}</td>
                    <td className="amount-cell muted">—</td>
                    <td className="muted">—</td>
                    <td className="muted">—</td>
                    <td className="muted">—</td>
                    <td className="muted" colSpan={editable ? 2 : 1}>
                      <span className="status status-draft">Not on file</span>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={w.id}>
                  <td className="strong">{t.label}</td>
                  <td className="amount-cell">{fmtMoney(w.amount)}</td>
                  <td className="muted">{w.through_date || '—'}</td>
                  <td className="muted">{w.signed_date || '—'}</td>
                  <td>
                    {w.document_id ? (
                      <a href={api.documentUrl(w.document_id)} target="_blank" rel="noopener noreferrer">
                        {w.document_filename || 'view'}
                      </a>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td className="muted">{w.notes || '—'}</td>
                  {editable && (
                    <td className="col-action">
                      <button className="btn-icon" title="Delete" onClick={() => handleDelete(w)}>×</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {editable && showNew && (
        <NewWaiverForm
          existingTypes={Object.keys(byType)}
          defaultAmount={payApp.current_due}
          defaultDate={payApp.period_end}
          onCreate={handleCreate}
          onCancel={() => setShowNew(false)}
        />
      )}
    </section>
  );
}

function NewWaiverForm({ existingTypes, defaultAmount, defaultDate, onCreate, onCancel }) {
  // Pre-pick the first waiver type that hasn't been recorded yet.
  const firstAvailable = WAIVER_TYPES.find(t => !existingTypes.includes(t.id))?.id
    || WAIVER_TYPES[0].id;

  const [form, setForm] = useState({
    waiver_type: firstAvailable,
    amount: defaultAmount != null ? String(defaultAmount) : '',
    through_date: defaultDate || '',
    signed_date: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  function update(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await onCreate({
        waiver_type: form.waiver_type,
        amount: parseMoney(form.amount),
        through_date: form.through_date || null,
        signed_date: form.signed_date || null,
        notes: form.notes || null,
      });
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <form className="new-line-form" onSubmit={submit} style={{ marginTop: 12 }}>
      <select value={form.waiver_type} onChange={(e) => update('waiver_type', e.target.value)}>
        {WAIVER_TYPES.map(t => (
          <option key={t.id} value={t.id}>
            {t.label}{existingTypes.includes(t.id) ? ' (replace existing)' : ''}
          </option>
        ))}
      </select>
      <input
        placeholder="Amount"
        value={form.amount}
        onChange={(e) => update('amount', e.target.value)}
        autoFocus
      />
      <input
        type="date"
        title="Through date"
        value={form.through_date}
        onChange={(e) => update('through_date', e.target.value)}
      />
      <input
        type="date"
        title="Signed date"
        value={form.signed_date}
        onChange={(e) => update('signed_date', e.target.value)}
      />
      <input
        placeholder="Notes (optional)"
        value={form.notes}
        onChange={(e) => update('notes', e.target.value)}
      />
      <button type="submit" disabled={busy} className="btn-primary btn-sm">
        {busy ? '…' : 'Add'}
      </button>
      <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary btn-sm">
        Cancel
      </button>
      {err && <div className="error span-all">{err}</div>}
    </form>
  );
}
