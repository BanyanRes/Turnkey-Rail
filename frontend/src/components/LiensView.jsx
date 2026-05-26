// Liens tab — unified view of all lien waivers in both directions.
//
// Inbound  (subs → us)   = lien waivers we collect from subcontractors.
// Outbound (us → owner)  = lien waivers we issue to the owner.
//
// Direction toggle at the top. Filters by project. Outbound has its own
// "+ New" form (period_start/period_end, no sub). Inbound creation is done
// inside Pay App detail (LienWaiversSection); here you only view/edit/delete
// inbound waivers across the project.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api';
import { fmtMoney, parseMoney } from '../utils';
import { canEdit } from '../permissions';

const WAIVER_TYPES = [
  { id: 'conditional_progress',   label: 'Conditional · Progress' },
  { id: 'unconditional_progress', label: 'Unconditional · Progress' },
  { id: 'conditional_final',      label: 'Conditional · Final' },
  { id: 'unconditional_final',    label: 'Unconditional · Final' },
];
const TYPE_LABEL = Object.fromEntries(WAIVER_TYPES.map(t => [t.id, t.label]));

export default function LiensView({ me }) {
  const editable = canEdit(me, 'liens');
  const [direction, setDirection] = useState('inbound');
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [waivers, setWaivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [warnings, setWarnings] = useState(null);

  useEffect(() => {
    api.listProjects()
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);

  // Warnings only depend on payment state, not the filters, so fetch once
  // per refresh cycle alongside the list.
  const loadWarnings = useCallback(async () => {
    try {
      const w = await api.getLienWaiverWarnings();
      setWarnings(w);
    } catch { /* don't block the page on warning fetch */ }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = { direction };
      if (projectId) params.project_id = projectId;
      const data = await api.listLienWaivers(params);
      setWaivers(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [direction, projectId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { loadWarnings(); }, [loadWarnings, waivers]);

  async function handleDelete(w) {
    if (!confirm(`Delete this ${TYPE_LABEL[w.waiver_type] || w.waiver_type} waiver?`)) return;
    try {
      await api.deleteLienWaiver(w.id);
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <>
      {warnings && warnings.total > 0 && (
        <WarningBanner warnings={warnings} />
      )}

      <div className="view-toolbar">
        <div className="filter-bar">
          <DirectionToggle value={direction} onChange={setDirection} />
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="select-input"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
            ))}
          </select>
        </div>
        {editable && direction === 'outbound' && (
          <button className="btn-primary" onClick={() => setShowNew(true)}>+ New Outbound Waiver</button>
        )}
        {editable && direction === 'inbound' && (
          <span className="muted" style={{ fontSize: 13 }}>
            New inbound waivers are added from a Pay App's detail page.
          </span>
        )}
      </div>

      <main className="vendors-main">
        {error && <div className="error">{error}</div>}
        {loading ? (
          <div className="muted">Loading…</div>
        ) : waivers.length === 0 ? (
          <div className="empty-state">
            No {direction} waivers{projectId ? ' for this project' : ''} yet.
          </div>
        ) : direction === 'inbound' ? (
          <InboundTable
            waivers={waivers}
            onDelete={handleDelete}
            editable={editable}
          />
        ) : (
          <OutboundTable
            waivers={waivers}
            onDelete={handleDelete}
            editable={editable}
          />
        )}
      </main>

      {showNew && direction === 'outbound' && (
        <NewOutboundForm
          projects={projects}
          defaultProjectId={projectId}
          onCreated={() => { setShowNew(false); refresh(); }}
          onCancel={() => setShowNew(false)}
        />
      )}
    </>
  );
}

function DirectionToggle({ value, onChange }) {
  return (
    <div className="seg-toggle">
      <button
        type="button"
        className={value === 'inbound' ? 'seg-active' : ''}
        onClick={() => onChange('inbound')}
      >
        Inbound (from subs)
      </button>
      <button
        type="button"
        className={value === 'outbound' ? 'seg-active' : ''}
        onClick={() => onChange('outbound')}
      >
        Outbound (to owner)
      </button>
    </div>
  );
}

function InboundTable({ waivers, onDelete, editable }) {
  return (
    <table className="vendors-table">
      <thead>
        <tr>
          <th>Project</th>
          <th>Sub</th>
          <th>Type</th>
          <th>Pay App</th>
          <th className="amount-th">Amount</th>
          <th>Through</th>
          <th>Signed</th>
          <th>PDF</th>
          {editable && <th></th>}
        </tr>
      </thead>
      <tbody>
        {waivers.map((w) => (
          <tr key={w.id}>
            <td>
              <span className="code">{w.project_code}</span>{' '}
              <span className="muted">— {w.project_name}</span>
            </td>
            <td>{w.subcontractor_name || <span className="muted">—</span>}</td>
            <td>{TYPE_LABEL[w.waiver_type] || w.waiver_type}</td>
            <td className="muted">{w.pay_app_number ? `#${w.pay_app_number}` : '—'}</td>
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
            {editable && (
              <td className="col-action">
                <button className="btn-icon" title="Delete" onClick={() => onDelete(w)}>×</button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OutboundTable({ waivers, onDelete, editable }) {
  return (
    <table className="vendors-table">
      <thead>
        <tr>
          <th>Project</th>
          <th>Type</th>
          <th>Period</th>
          <th className="amount-th">Amount</th>
          <th>Through</th>
          <th>Signed</th>
          <th>PDF</th>
          <th>Notes</th>
          {editable && <th></th>}
        </tr>
      </thead>
      <tbody>
        {waivers.map((w) => (
          <tr key={w.id}>
            <td>
              <span className="code">{w.project_code}</span>{' '}
              <span className="muted">— {w.project_name}</span>
            </td>
            <td>{TYPE_LABEL[w.waiver_type] || w.waiver_type}</td>
            <td className="muted">
              {w.period_start && w.period_end
                ? `${w.period_start} → ${w.period_end}`
                : (w.period_end || w.period_start || '—')}
            </td>
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
                <button className="btn-icon" title="Delete" onClick={() => onDelete(w)}>×</button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NewOutboundForm({ projects, defaultProjectId, onCreated, onCancel }) {
  const [form, setForm] = useState({
    project_id: defaultProjectId || '',
    waiver_type: 'conditional_progress',
    amount: '',
    period_start: '',
    period_end: '',
    through_date: '',
    signed_date: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function update(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit(e) {
    e.preventDefault();
    if (!form.project_id) {
      setError('Project is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createLienWaiver({
        direction: 'outbound',
        project_id: Number(form.project_id),
        waiver_type: form.waiver_type,
        amount: parseMoney(form.amount),
        period_start: form.period_start || null,
        period_end: form.period_end || null,
        through_date: form.through_date || (form.period_end || null),
        signed_date: form.signed_date || null,
        notes: form.notes || null,
      });
      onCreated();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New Outbound Waiver</h2>
        <div className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: 13 }}>
          A waiver issued by us (GC) to the project owner.
        </div>

        <label>
          Project *
          <select
            value={form.project_id}
            onChange={(e) => update('project_id', e.target.value)}
            autoFocus
          >
            <option value="">— Select —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
            ))}
          </select>
        </label>

        <label>
          Waiver type
          <select
            value={form.waiver_type}
            onChange={(e) => update('waiver_type', e.target.value)}
          >
            {WAIVER_TYPES.map(t => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </label>

        <label>
          Amount
          <input
            value={form.amount}
            onChange={(e) => update('amount', e.target.value)}
            placeholder="0.00"
          />
        </label>

        <div className="row-2">
          <label>
            Period start
            <input
              type="date"
              value={form.period_start}
              onChange={(e) => update('period_start', e.target.value)}
            />
          </label>
          <label>
            Period end
            <input
              type="date"
              value={form.period_end}
              onChange={(e) => update('period_end', e.target.value)}
            />
          </label>
        </div>

        <div className="row-2">
          <label>
            Through date
            <input
              type="date"
              value={form.through_date}
              onChange={(e) => update('through_date', e.target.value)}
            />
          </label>
          <label>
            Signed date
            <input
              type="date"
              value={form.signed_date}
              onChange={(e) => update('signed_date', e.target.value)}
            />
          </label>
        </div>

        <label>
          Notes
          <input
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
            placeholder="Optional"
          />
        </label>

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

// Warning banner — surfaces missing unconditional waivers on paid pay apps.
// Limits visible items to keep the banner compact; full list lives below.
function WarningBanner({ warnings }) {
  const progress = warnings.missing_unconditional_progress || [];
  const final = warnings.missing_unconditional_final || [];
  const SHOW_LIMIT = 5;

  return (
    <div className="lien-warning-banner">
      <div className="lien-warning-title">
        ⚠ {warnings.total} lien waiver{warnings.total === 1 ? '' : 's'} pending
      </div>

      {progress.length > 0 && (
        <div className="lien-warning-section">
          <div className="lien-warning-subtitle">
            Missing <strong>unconditional progress</strong> waiver
            {progress.length === 1 ? '' : 's'} ({progress.length}):
          </div>
          <ul>
            {progress.slice(0, SHOW_LIMIT).map((r) => (
              <li key={r.pay_app_id}>
                <span className="code">{r.project_code}</span>{' '}
                — Pay App #{r.pay_app_number} for{' '}
                <strong>{r.subcontractor_name}</strong>{' '}
                <span className="muted">(paid, no uncond. progress on file)</span>
              </li>
            ))}
            {progress.length > SHOW_LIMIT && (
              <li className="muted">…and {progress.length - SHOW_LIMIT} more</li>
            )}
          </ul>
        </div>
      )}

      {final.length > 0 && (
        <div className="lien-warning-section">
          <div className="lien-warning-subtitle">
            Missing <strong>unconditional final</strong> waiver
            {final.length === 1 ? '' : 's'} ({final.length}):
          </div>
          <ul>
            {final.slice(0, SHOW_LIMIT).map((r) => (
              <li key={r.pay_app_id}>
                <span className="code">{r.project_code}</span>{' '}
                — Pay App #{r.pay_app_number} for{' '}
                <strong>{r.subcontractor_name}</strong>{' '}
                <span className="muted">(final paid, no uncond. final on file)</span>
              </li>
            ))}
            {final.length > SHOW_LIMIT && (
              <li className="muted">…and {final.length - SHOW_LIMIT} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
