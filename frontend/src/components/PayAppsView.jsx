import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { fmtMoney, parseMoney } from '../utils';
import { canEdit } from '../permissions';
import LienWaiversSection from './LienWaiversSection';

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
};

export default function PayAppsView({ me }) {
  const editable = canEdit(me, 'payapps');
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [autoCreating, setAutoCreating] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // 'all' | 'owner' | 'sub' — controls which pay apps the list shows.
  const [scope, setScope] = useState('all');
  const bumpRefresh = () => setRefreshTick((t) => t + 1);

  if (selectedId) {
    return (
      <PayAppDetail
        payAppId={selectedId}
        onBack={() => { setSelectedId(null); bumpRefresh(); }}
        editable={editable}
      />
    );
  }

  return (
    <>
      <div className="view-toolbar">
        <div className="filter-bar">
          <div className="seg-toggle">
            <button
              type="button"
              className={scope === 'all' ? 'seg-active' : ''}
              onClick={() => setScope('all')}
            >All</button>
            <button
              type="button"
              className={scope === 'owner' ? 'seg-active' : ''}
              onClick={() => setScope('owner')}
            >Owner billings</button>
            <button
              type="button"
              className={scope === 'sub' ? 'seg-active' : ''}
              onClick={() => setScope('sub')}
            >Sub pay apps</button>
          </div>
        </div>
        {editable && (
          <div className="filter-bar">
            <button
              className="btn-secondary"
              onClick={() => setAutoCreating(true)}
              title="Roll forward the prior pay app for a project (Owner or Sub)"
            >
              ⟳ Start next cycle
            </button>
            <button className="btn-primary" onClick={() => setCreating(true)}>+ New Pay App</button>
          </div>
        )}
      </div>
      <PayAppsList
        onSelect={setSelectedId}
        refreshTick={refreshTick}
        scope={scope}
      />
      {creating && (
        <NewPayAppForm
          onCreated={(id) => { setCreating(false); setSelectedId(id); }}
          onCancel={() => setCreating(false)}
        />
      )}
      {autoCreating && (
        <AutoCreateForm
          onCreated={(id) => { setAutoCreating(false); setSelectedId(id); }}
          onCancel={() => setAutoCreating(false)}
        />
      )}
    </>
  );
}

// =====================================================
// List
// =====================================================
function PayAppsList({ onSelect, refreshTick, scope = 'all' }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.listPayApps()
      .then((data) => { setItems(data); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [refreshTick]);

  // Filter client-side. Owner = no subcontractor; Sub = has subcontractor.
  const filtered = items.filter((p) => {
    if (scope === 'owner') return p.subcontractor_id == null;
    if (scope === 'sub') return p.subcontractor_id != null;
    return true;
  });

  return (
    <main className="vendors-main">
      {error && <div className="error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          {scope === 'owner'
            ? 'No Owner billings yet. Click "⟳ Start next cycle" to create the first one for a project.'
            : scope === 'sub'
            ? 'No Sub pay applications yet.'
            : 'No pay applications yet. Click "+ New Pay App" to create one.'}
        </div>
      ) : (
        <table className="vendors-table">
          <thead>
            <tr>
              <th style={{ width: 60 }}>#</th>
              <th>Project</th>
              <th>Billing to</th>
              <th>Period</th>
              <th>Status</th>
              <th className="amount-th">Completed</th>
              <th className="amount-th">Due this period</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} className="vendor-row" onClick={() => onSelect(p.id)}>
                <td className="strong">#{p.app_number}</td>
                <td>
                  <span className="code">{p.project_code}</span>{' '}
                  <span className="muted">— {p.project_name}</span>
                </td>
                <td>
                  {p.subcontractor_name ? (
                    <>{p.subcontractor_name}{p.subcontractor_trade ? <span className="muted"> · {p.subcontractor_trade}</span> : null}</>
                  ) : (
                    <span className="badge-owner">Owner billing</span>
                  )}
                </td>
                <td className="muted">
                  {p.period_start && p.period_end
                    ? `${p.period_start} → ${p.period_end}`
                    : (p.period_end || p.period_start || '—')}
                </td>
                <td>
                  <span className={`status status-${p.status}`}>
                    {STATUS_LABELS[p.status] || p.status}
                  </span>
                </td>
                <td className="amount-cell">{fmtMoney(p.total_completed)}</td>
                <td className="amount-cell strong">{fmtMoney(p.current_due)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

// =====================================================
// Auto-create form (modal) — the big monthly time-saver.
// Pick a project + Owner-or-Sub side; server rolls the prior cycle forward
// (carries SoV lines, rolls "Total" into next "Prior", clears "This period"),
// or seeds from project budget if nothing exists yet.
// =====================================================
function AutoCreateForm({ onCreated, onCancel }) {
  const [projects, setProjects] = useState([]);
  const [subs, setSubs] = useState([]);
  const [side, setSide] = useState('owner'); // 'owner' | 'sub'
  const [projectId, setProjectId] = useState('');
  const [subId, setSubId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.listProjects(), api.listSubs({ status: 'active' })])
      .then(([ps, ss]) => { setProjects(ps); setSubs(ss); })
      .catch((e) => setError(e.message));
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!projectId) { setError('Project is required'); return; }
    if (side === 'sub' && !subId) { setError('Subcontractor is required'); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await api.autoCreatePayApp({
        project_id: Number(projectId),
        subcontractor_id: side === 'sub' ? Number(subId) : null,
      });
      onCreated(created.id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Start next pay-app cycle</h2>
        <div className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: 13 }}>
          Rolls the most recent pay app forward: copies the Schedule of Values,
          rolls each line's <strong>Total</strong> into next month's <strong>Prior</strong>,
          and clears the <strong>This period</strong> column for you to fill in.
          If no prior pay app exists, seeds the Schedule of Values from the project budget.
        </div>

        <label>
          Side
          <div className="seg-toggle" style={{ marginTop: 4 }}>
            <button
              type="button"
              className={side === 'owner' ? 'seg-active' : ''}
              onClick={() => setSide('owner')}
            >Owner billing</button>
            <button
              type="button"
              className={side === 'sub' ? 'seg-active' : ''}
              onClick={() => setSide('sub')}
            >Sub pay app</button>
          </div>
        </label>

        <label>
          Project *
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            autoFocus
          >
            <option value="">— Select a project —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
            ))}
          </select>
        </label>

        {side === 'sub' && (
          <label>
            Subcontractor *
            <select value={subId} onChange={(e) => setSubId(e.target.value)}>
              <option value="">— Select a sub —</option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.trade ? ` (${s.trade})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onCancel} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create next cycle'}
          </button>
        </div>
      </form>
    </div>
  );
}

// =====================================================
// Create form (modal)
// =====================================================
function NewPayAppForm({ onCreated, onCancel }) {
  const [projects, setProjects] = useState([]);
  const [subs, setSubs] = useState([]);
  const [form, setForm] = useState({
    project_id: '',
    subcontractor_id: '',
    period_start: '',
    period_end: '',
    retainage_pct: 10,
  });
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
    if (!form.project_id) {
      setError('Project is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        project_id: Number(form.project_id),
        subcontractor_id: form.subcontractor_id ? Number(form.subcontractor_id) : null,
        period_start: form.period_start || null,
        period_end: form.period_end || null,
        retainage_pct: Number(form.retainage_pct) || 0,
      };
      const created = await api.createPayApp(payload);
      onCreated(created.id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New Pay Application</h2>

        <label>
          Project *
          <select
            value={form.project_id}
            onChange={(e) => update('project_id', e.target.value)}
            autoFocus
          >
            <option value="">— Select a project —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} — {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Vendor (optional)
          <select
            value={form.subcontractor_id}
            onChange={(e) => update('subcontractor_id', e.target.value)}
          >
            <option value="">— None / GC self-pay —</option>
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.trade ? ` (${s.trade})` : ''}
              </option>
            ))}
          </select>
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

        <label>
          Retainage %
          <input
            type="number"
            min="0"
            max="100"
            step="0.5"
            value={form.retainage_pct}
            onChange={(e) => update('retainage_pct', e.target.value)}
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

// =====================================================
// Detail (G703-style)
// =====================================================
function PayAppDetail({ payAppId, onBack, editable = true }) {
  const [payApp, setPayApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNewLine, setShowNewLine] = useState(false);
  // Phase 2: hide lines untouched this period to make monthly entry faster.
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  // Phase 2: button busy-state while re-pulling approved-CO total.
  const [syncingCOs, setSyncingCOs] = useState(false);
  // #9 SoV import modal.
  const [showImport, setShowImport] = useState(false);
  // #12 Variance alerts. We refetch these whenever the pay app is reloaded
  // so the banner reflects the latest edits without the user refreshing.
  const [alerts, setAlerts] = useState([]);

  const load = useCallback(async () => {
    try {
      const data = await api.getPayApp(payAppId);
      setPayApp(data);
      setError(null);
      // Alerts are non-blocking — if the call fails, we just don't show a
      // banner. Don't make the whole page error out on a flaky alerts response.
      try {
        const result = await api.getPayAppAlerts(payAppId);
        setAlerts(result.alerts || []);
      } catch {
        setAlerts([]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [payAppId]);

  useEffect(() => { load(); }, [load]);

  async function updateLine(id, patch) {
    await api.updatePayAppLine(id, patch);
    await load();
  }

  async function deleteLine(id) {
    if (!confirm('Delete this line?')) return;
    await api.deletePayAppLine(id);
    await load();
  }

  async function addLine(data) {
    await api.createPayAppLine(payAppId, data);
    setShowNewLine(false);
    await load();
  }

  async function changeStatus(newStatus) {
    await api.updatePayApp(payAppId, { status: newStatus });
    await load();
  }

  async function resyncCloudLedger() {
    if (!payApp) return;
    try {
      const r = await api.fetch('/api/pay-apps/' + payApp.id + '/cloudledger/resync', { method: 'POST' });
      setPayApp((prev) => prev ? ({ ...prev,
        cloudledger_je_approved_id: r.cloudledger_je_approved_id,
        cloudledger_je_paid_id: r.cloudledger_je_paid_id,
      }) : prev);
    } catch (e) {
      alert('CloudLedger resync failed: ' + e.message);
    }
  }

  async function updateHeader(patch) {
    await api.updatePayApp(payAppId, patch);
    await load();
  }

  async function handleDelete() {
    if (!confirm(`Delete pay app #${payApp.app_number}? This removes all lines too.`)) return;
    await api.deletePayApp(payAppId);
    onBack();
  }

  // Phase 2: pull current approved CO total from the project into this pay app's
  // change_orders field. Used by the 🔄 Sync COs button in the header.
  async function syncChangeOrders() {
    setSyncingCOs(true);
    try {
      await api.refreshChangeOrders(payAppId);
      await load();
    } catch (e) {
      alert(e.message);
    } finally {
      setSyncingCOs(false);
    }
  }

  if (loading) return <div className="vendors-main muted">Loading…</div>;
  if (error) return <div className="vendors-main"><div className="error">{error}</div></div>;
  if (!payApp) return null;

  return (
    <>
      <div className="view-toolbar">
        <div className="filter-bar">
          <button className="btn-secondary btn-sm" onClick={onBack}>← Back to list</button>
        </div>
        <div className="filter-bar">
          <a
            href={api.payAppPdfUrl(payAppId)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary btn-sm"
            title="Open AIA G702/G703-style PDF"
            style={{ textDecoration: 'none' }}
          >
            📄 Export PDF
          </a>
          <a
            href={api.sovTemplateUrl(payAppId)}
            className="btn-secondary btn-sm"
            title={payApp.lines.length > 0
              ? 'Download an Excel template pre-filled with the current SoV'
              : 'Download a blank SoV Excel template'}
            style={{ textDecoration: 'none' }}
          >
            📊 Excel
          </a>
          {editable && (
            <button
              className="btn-secondary btn-sm"
              onClick={() => setShowImport(true)}
              title="Import a Schedule of Values from an Excel file"
            >
              📥 Import SoV
            </button>
          )}
          {editable ? (
            <StatusChanger current={payApp.status} onChange={changeStatus} />
          ) : (
            <span className={`status status-${payApp.status}`}>{STATUS_LABELS[payApp.status] || payApp.status}</span>
          )}
          {editable && <button className="btn-danger btn-sm" onClick={handleDelete}>Delete</button>}
        </div>
      </div>

      <main className="vendors-main">
        <div className="payapp-header">
          <div>
            <div className="muted code-label">PAY APP #{payApp.app_number}</div>
            <h2>{payApp.project_code} — {payApp.project_name}</h2>
            <div className="muted">
              {payApp.subcontractor_name
                ? `${payApp.subcontractor_name}${payApp.subcontractor_trade ? ` · ${payApp.subcontractor_trade}` : ''}`
                : 'Owner billing'}
            </div>
          </div>
          <div className="payapp-header-meta">
            <PeriodEdit payApp={payApp} onSave={updateHeader} editable={editable} />
            <RetainageEdit
              pct={payApp.retainage_pct}
              onSave={(v) => updateHeader({ retainage_pct: v })}
              editable={editable}
            />
            <ContractSumBlock
              contractSum={payApp.contract_sum}
              changeOrders={payApp.change_orders}
              onSync={editable ? syncChangeOrders : null}
              syncing={syncingCOs}
              onSaveContractSum={editable ? ((v) => updateHeader({ contract_sum: v })) : null}
              editable={editable}
            />
            {payApp.subcontractor_id ? (
              <PaymentMethodEdit
                value={payApp.payment_method}
                onSave={(v) => updateHeader({ payment_method: v })}
                editable={editable}
              />
            ) : null}
            <CloudLedgerInfo payApp={payApp} editable={editable} onResync={resyncCloudLedger} />
          </div>
        </div>

        <AlertsBanner alerts={alerts} />

        <div className="section-header">
          <h3>Schedule of values (G703)</h3>
          <div className="filter-bar">
            <label className="filter-toggle" title="Hide lines with no activity this period">
              <input
                type="checkbox"
                checked={showChangedOnly}
                onChange={(e) => setShowChangedOnly(e.target.checked)}
              />
              <span>Changed this period only</span>
            </label>
            {editable && !showNewLine && (
              <button className="btn-secondary btn-sm" onClick={() => setShowNewLine(true)}>
                + Add line
              </button>
            )}
          </div>
        </div>

        <div className="g703-wrap">
          <table className="g703-table">
            <thead>
              <tr>
                <th>Description</th>
                <th className="amount-th">Scheduled (C)</th>
                <th className="amount-th">Prior (D)</th>
                <th className="amount-th">This period (E)</th>
                <th className="amount-th">Stored (F)</th>
                <th className="amount-th">Total (G)</th>
                <th className="amount-th">%</th>
                <th className="amount-th">To finish</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {payApp.lines.length === 0 && (
                <tr>
                  <td colSpan="9" className="muted center pad">
                    No line items yet. Click "+ Add line".
                  </td>
                </tr>
              )}
              {(() => {
                const visible = showChangedOnly
                  ? payApp.lines.filter((l) => Number(l.completed_this_period || 0) !== 0)
                  : payApp.lines;
                if (payApp.lines.length > 0 && visible.length === 0) {
                  return (
                    <tr>
                      <td colSpan="9" className="muted center pad">
                        No lines changed this period. Uncheck the filter to see all.
                      </td>
                    </tr>
                  );
                }
                return visible.map((l) => {
                  const completed = Number(l.completed_previous || 0) + Number(l.completed_this_period || 0) + Number(l.stored_materials || 0);
                  const sched = Number(l.scheduled_value || 0);
                  const pct = sched > 0 ? (completed / sched) * 100 : 0;
                  const toFinish = sched - completed;
                  return (
                    <tr key={l.id}>
                      <td>{l.description}</td>
                      <td className="amount-cell">
                        <InlineNum value={l.scheduled_value}
                          onSave={(v) => updateLine(l.id, { scheduled_value: v })} />
                      </td>
                      <td className="amount-cell">
                        <InlineNum value={l.completed_previous}
                          onSave={(v) => updateLine(l.id, { completed_previous: v })} />
                      </td>
                      <td className="amount-cell">
                        <InlineNum value={l.completed_this_period}
                          onSave={(v) => updateLine(l.id, { completed_this_period: v })} />
                      </td>
                      <td className="amount-cell">
                        <InlineNum value={l.stored_materials}
                          onSave={(v) => updateLine(l.id, { stored_materials: v })} />
                      </td>
                      <td className="amount-cell strong">{fmtMoney(completed)}</td>
                      <td className="amount-cell">
                        <InlinePct
                          pct={pct}
                          line={l}
                          onSave={(newThisPeriod) => updateLine(l.id, { completed_this_period: newThisPeriod })}
                        />
                      </td>
                      <td className="amount-cell muted">{fmtMoney(toFinish)}</td>
                      <td className="col-action">
                        <button className="btn-icon" onClick={() => deleteLine(l.id)} title="Delete">×</button>
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
            <tfoot>
              <tr>
                <td className="strong">Total</td>
                <td className="amount-cell strong">{fmtMoney(payApp.scheduled_total)}</td>
                <td className="amount-cell">{fmtMoney(payApp.prior_total)}</td>
                <td className="amount-cell">{fmtMoney(payApp.this_period_total)}</td>
                <td className="amount-cell">{fmtMoney(payApp.stored_total)}</td>
                <td className="amount-cell strong">{fmtMoney(payApp.total_completed)}</td>
                <td colSpan="3"></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {showNewLine && (
          <NewLineForm onCreate={addLine} onCancel={() => setShowNewLine(false)} />
        )}

        <LienWaiversSection payApp={payApp} editable={editable} />

        <PayAppDocumentsSection
          payAppId={payAppId}
          projectId={payApp.project_id}
          editable={editable}
        />

        <SummaryPanel payApp={payApp} />
      </main>

      {showImport && (
        <ImportSovModal
          payAppId={payAppId}
          hasExistingLines={payApp.lines.length > 0}
          onClose={() => setShowImport(false)}
          onImported={async () => { setShowImport(false); await load(); }}
        />
      )}
    </>
  );
}

function SummaryPanel({ payApp }) {
  return (
    <div className="summary-panel">
      <div className="summary-row">
        <span>Total completed & stored</span>
        <span className="amount-cell strong">{fmtMoney(payApp.total_completed)}</span>
      </div>
      <div className="summary-row">
        <span>Less retainage ({payApp.retainage_pct}%)</span>
        <span className="amount-cell">({fmtMoney(payApp.retainage_amount)})</span>
      </div>
      <div className="summary-row">
        <span>Earned less retainage</span>
        <span className="amount-cell">{fmtMoney(payApp.earned_less_retainage)}</span>
      </div>
      <div className="summary-row">
        <span>Less prior certificates (net)</span>
        <span className="amount-cell">
          ({fmtMoney(payApp.prior_total * (1 - payApp.retainage_pct / 100))})
        </span>
      </div>
      <div className="summary-row summary-total">
        <span>Current payment due</span>
        <span className="amount-cell strong">{fmtMoney(payApp.current_due)}</span>
      </div>
    </div>
  );
}

function StatusChanger({ current, onChange }) {
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      className="select-input"
    >
      <option value="draft">Draft</option>
      <option value="submitted">Submitted</option>
      <option value="approved">Approved</option>
      <option value="paid">Paid</option>
      <option value="rejected">Rejected</option>
    </select>
  );
}

function PeriodEdit({ payApp, onSave, editable = true }) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(payApp.period_start || '');
  const [end, setEnd] = useState(payApp.period_end || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStart(payApp.period_start || '');
    setEnd(payApp.period_end || '');
  }, [payApp.period_start, payApp.period_end]);

  const text = payApp.period_start && payApp.period_end
    ? `${payApp.period_start} → ${payApp.period_end}`
    : 'No period set';

  async function commit() {
    if (saving) return;
    const nextStart = start || null;
    const nextEnd = end || null;
    if (nextStart === (payApp.period_start || null) && nextEnd === (payApp.period_end || null)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave({ period_start: nextStart, period_end: nextEnd });
      setEditing(false);
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="meta-item">
        <div className="label">Period</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="date"
            className="inline-input"
            value={start}
            disabled={saving}
            onChange={(e) => setStart(e.target.value)}
          />
          <span className="muted">→</span>
          <input
            type="date"
            className="inline-input"
            value={end}
            disabled={saving}
            onChange={(e) => setEnd(e.target.value)}
          />
          <button type="button" className="btn-icon" onClick={commit} disabled={saving} title="Save">
            {saving ? '…' : '✓'}
          </button>
          <button
            type="button"
            className="btn-icon"
            onClick={() => {
              setStart(payApp.period_start || '');
              setEnd(payApp.period_end || '');
              setEditing(false);
            }}
            disabled={saving}
            title="Cancel"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="meta-item">
      <div className="label">Period</div>
      <div
        className={editable ? 'inline-editable' : ''}
        onClick={() => editable && setEditing(true)}
        style={{ cursor: editable ? 'pointer' : 'default' }}
        title={editable ? 'Click to edit the billing period' : ''}
      >
        {text}
      </div>
    </div>
  );
}

function RetainageEdit({ pct, onSave, editable = true }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(pct);
  useEffect(() => setVal(pct), [pct]);

  const released = Number(pct) === 0;

  async function release() {
    if (!confirm('Release retainage on this pay app? Retainage % will be set to 0, which means the full held-back amount becomes payable on the next certificate. Typically done at project closeout or for a final pay app.')) {
      return;
    }
    await onSave(0);
  }

  async function reinstate() {
    // Default back to the company-standard 10%. The user can edit it after.
    await onSave(10);
  }

  if (editing && !released) {
    return (
      <div className="meta-item">
        <div className="label">Retainage</div>
        <input
          autoFocus
          type="number"
          min="0" max="100" step="0.5"
          className="inline-input"
          style={{ width: 70 }}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={async () => {
            const n = Number(val);
            if (!Number.isNaN(n) && n !== pct) await onSave(n);
            setEditing(false);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(false); }}
        />
      </div>
    );
  }

  if (released) {
    // Released state: bold "released" affordance plus a quiet escape hatch
    // (Reinstate) in case the user clicked through the confirm by mistake.
    return (
      <div className="meta-item retainage-released">
        <div className="label">Retainage</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="strong" style={{ color: '#10b981' }}>Released ✓</span>
          {editable && (
            <button
              type="button"
              className="btn-icon"
              onClick={reinstate}
              title="Set retainage back to 10% (in case this was released by mistake)"
              style={{ fontSize: 11, padding: '0 4px', color: '#6b7280' }}
            >
              Reinstate
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="meta-item">
      <div className="label">Retainage</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          className="strong"
          onClick={() => editable && setEditing(true)}
          style={{ cursor: editable ? 'pointer' : 'default' }}
          title={editable ? 'Click to edit %' : ''}
        >
          {pct}%
        </span>
        {editable && (
          <button
            type="button"
            className="btn-icon"
            onClick={release}
            title="Release retainage (set to 0% — typically at final pay app or project closeout)"
            style={{ fontSize: 11, padding: '0 6px', color: '#6b7280' }}
          >
            Release
          </button>
        )}
      </div>
    </div>
  );
}

function InlineNum({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? 0));
  const [saving, setSaving] = useState(false);

  if (editing) {
    return (
      <input
        autoFocus
        className="inline-input"
        type="text"
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={async () => {
          if (saving) return;
          const parsed = parseMoney(draft);
          if (parsed === Number(value)) { setEditing(false); return; }
          setSaving(true);
          try { await onSave(parsed); setEditing(false); }
          catch (e) { alert(e.message); }
          finally { setSaving(false); }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
          if (e.key === 'Escape') { setDraft(String(value ?? 0)); setEditing(false); }
        }}
      />
    );
  }
  return (
    <span className="inline-editable" onClick={() => { setDraft(String(value ?? 0)); setEditing(true); }}>
      {fmtMoney(value)}
    </span>
  );
}

// Phase 2: click % to type a new target, and we back-solve the "this period" $
// from that target (target% × scheduled − prior − stored). The point is to let
// the user say "this line is at 75%" without doing the math themselves.
function InlinePct({ pct, line, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(Math.round(pct)));
  const [saving, setSaving] = useState(false);

  if (editing) {
    return (
      <input
        autoFocus
        className="inline-input"
        type="text"
        style={{ width: 56, textAlign: 'right' }}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={async () => {
          if (saving) return;
          const stripped = String(draft).replace(/[%\s,]/g, '');
          const parsed = Number(stripped);
          if (Number.isNaN(parsed) || stripped === '') { setEditing(false); return; }
          const target = Math.max(0, Math.min(100, parsed));
          const sched = Number(line.scheduled_value || 0);
          if (sched <= 0) { setEditing(false); return; }
          const prior = Number(line.completed_previous || 0);
          const stored = Number(line.stored_materials || 0);
          // Required "this period" $ = target% of scheduled, minus what's already
          // been counted as prior + stored. Floor at 0 so going backwards is a no-op.
          const newThisPeriod = Math.max(0, Math.round(((target / 100) * sched - prior - stored) * 100) / 100);
          const current = Number(line.completed_this_period || 0);
          if (newThisPeriod === current) { setEditing(false); return; }
          setSaving(true);
          try { await onSave(newThisPeriod); setEditing(false); }
          catch (e) { alert(e.message); }
          finally { setSaving(false); }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
          if (e.key === 'Escape') { setDraft(String(Math.round(pct))); setEditing(false); }
        }}
      />
    );
  }
  return (
    <span
      className="inline-editable"
      title="Click to set a new % complete — the 'this period' $ will be back-calculated"
      onClick={() => { setDraft(String(Math.round(pct))); setEditing(true); }}
    >
      {pct.toFixed(0)}%
    </span>
  );
}

// Phase 2: Original Contract Sum + Approved COs = Revised Contract Sum.
// 🔄 button re-pulls the project's approved-CO total into this pay app.
function PaymentMethodEdit({ value, onSave, editable }) {
  const opts = [
    { v: '',          label: '(not set)' },
    { v: 'wire',      label: 'Wire transfer' },
    { v: 'ach',       label: 'ACH' },
    { v: 'check',     label: 'Check' },
    { v: 'bill_com',  label: 'Bill.com' },
  ];
  if (!editable) {
    const found = opts.find((o) => o.v === (value || ''));
    return (
      <div className="meta-block">
        <div className="muted">Payment method</div>
        <div className="strong">{found ? found.label : '—'}</div>
      </div>
    );
  }
  return (
    <div className="meta-block">
      <div className="muted">Payment method</div>
      <select
        value={value || ''}
        onChange={(e) => onSave(e.target.value || null)}
        className="meta-select"
      >
        {opts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </div>
  );
}

function CloudLedgerInfo({ payApp, editable, onResync }) {
  const a = payApp.cloudledger_je_approved_id;
  const p = payApp.cloudledger_je_paid_id;
  if (!a && !p) {
    if (!editable) return null;
    return (
      <div className="meta-block">
        <div className="muted">CloudLedger</div>
        <button className="btn-sm" onClick={onResync} title="Push current status to CloudLedger">Sync now</button>
      </div>
    );
  }
  return (
    <div className="meta-block">
      <div className="muted">CloudLedger JE</div>
      <div className="strong">
        {a ? <span title="JE for approved status">#{a}</span> : '—'}
        {p ? <span title="JE for paid status" style={{ marginLeft: 6 }}>{' / #'}{p}</span> : ''}
      </div>
      {editable ? (
        <button className="btn-sm" onClick={onResync} style={{ marginTop: 4 }} title="Retry sync">Resync</button>
      ) : null}
    </div>
  );
}

function ContractSumBlock({ contractSum, changeOrders, onSync, syncing, onSaveContractSum, editable = true }) {
  const base = Number(contractSum || 0);
  const cos = Number(changeOrders || 0);
  const revised = base + cos;
  return (
    <div className="meta-item contract-sum-block">
      <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>Contract sum</span>
        {onSync && (
          <button
            type="button"
            className="btn-icon"
            onClick={onSync}
            disabled={syncing}
            title="Re-pull approved Change Orders from the project"
            style={{ fontSize: 12, padding: '0 4px' }}
          >
            {syncing ? '…' : '🔄'}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, lineHeight: 1.3 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span className="muted">Original</span>
          {editable && onSaveContractSum
            ? <InlineNum value={base} onSave={onSaveContractSum} />
            : <span>{fmtMoney(base)}</span>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span className="muted">+ Approved COs</span>
          <span>{fmtMoney(cos)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 2, marginTop: 2 }}>
          <span className="strong">Revised</span>
          <span className="strong">{fmtMoney(revised)}</span>
        </div>
      </div>
    </div>
  );
}

function NewLineForm({ onCreate, onCancel }) {
  const [form, setForm] = useState({
    description: '',
    scheduled_value: '',
    completed_previous: '',
    completed_this_period: '',
    stored_materials: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function update(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit(e) {
    e.preventDefault();
    if (!form.description.trim()) {
      setError('Description is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        description: form.description.trim(),
        scheduled_value: parseMoney(form.scheduled_value),
        completed_previous: parseMoney(form.completed_previous),
        completed_this_period: parseMoney(form.completed_this_period),
        stored_materials: parseMoney(form.stored_materials),
      });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <form className="new-line-form g703-new" onSubmit={submit}>
      <input
        placeholder="Description"
        value={form.description}
        onChange={(e) => update('description', e.target.value)}
        autoFocus
      />
      <input placeholder="Scheduled" value={form.scheduled_value}
        onChange={(e) => update('scheduled_value', e.target.value)} />
      <input placeholder="Prior" value={form.completed_previous}
        onChange={(e) => update('completed_previous', e.target.value)} />
      <input placeholder="This period" value={form.completed_this_period}
        onChange={(e) => update('completed_this_period', e.target.value)} />
      <input placeholder="Stored" value={form.stored_materials}
        onChange={(e) => update('stored_materials', e.target.value)} />
      <button type="submit" disabled={busy} className="btn-primary btn-sm">{busy ? '…' : 'Add'}</button>
      <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary btn-sm">Cancel</button>
      {error && <div className="error span-all">{error}</div>}
    </form>
  );
}

// SoV Excel import modal. Two modes:
//   - replace: wipe current SoV first, then load every row from the sheet.
//   - append: keep current SoV, add the sheet's rows at the end.
// We show a result summary after submit so the user sees how many rows landed
// vs were skipped.
function ImportSovModal({ payAppId, hasExistingLines, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState(hasExistingLines ? 'replace' : 'append');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!file) { setError('Choose an .xlsx file first'); return; }
    if (mode === 'replace' && hasExistingLines
      && !confirm('This will DELETE every existing SoV line on this pay app before importing. Continue?')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.importSov(payAppId, file, mode);
      const skippedNote = result.skipped > 0
        ? ` (${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped)`
        : '';
      alert(`Imported ${result.imported} line${result.imported === 1 ? '' : 's'}${skippedNote}.`);
      onImported();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Import Schedule of Values</h2>
        <div className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: 13 }}>
          Upload an Excel file with columns: <strong>Description</strong>, <strong>Scheduled Value</strong>,
          and optionally <strong>Prior</strong> / <strong>This Period</strong> / <strong>Stored</strong>.
          Header row should be row 1. Need a starting point?{' '}
          <a href={api.sovTemplateUrl(payAppId)} target="_blank" rel="noopener noreferrer">Download a template</a>.
        </div>

        <label>
          File *
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            autoFocus
          />
        </label>

        <label>
          Mode
          <div className="seg-toggle" style={{ marginTop: 4 }}>
            <button
              type="button"
              className={mode === 'replace' ? 'seg-active' : ''}
              onClick={() => setMode('replace')}
              disabled={busy}
            >Replace all</button>
            <button
              type="button"
              className={mode === 'append' ? 'seg-active' : ''}
              onClick={() => setMode('append')}
              disabled={busy}
            >Append</button>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {mode === 'replace'
              ? 'Existing SoV lines will be deleted before import.'
              : 'New rows are added after the existing lines.'}
          </div>
        </label>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onClose} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !file}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Variance / alert banner. Shows above the SoV table when the alerts endpoint
// returns anything. Empty list → render nothing (no banner clutter on clean
// pay apps). Errors get red, warnings get amber. The visual emphasis here is
// deliberate: this is the user's "are you sure?" check before submitting.
function AlertsBanner({ alerts }) {
  if (!alerts || alerts.length === 0) return null;
  const errors = alerts.filter((a) => a.severity === 'error');
  const warnings = alerts.filter((a) => a.severity === 'warning');
  const hasErrors = errors.length > 0;

  // Pick the dominant accent — errors win over warnings, since we want the
  // strongest visual signal when there's a real over-budget condition.
  const accent = hasErrors
    ? { border: '#ef4444', bg: '#fef2f2', label: '#991b1b' }
    : { border: '#f59e0b', bg: '#fffbeb', label: '#92400e' };

  return (
    <div
      style={{
        border: `1px solid ${accent.border}`,
        background: accent.bg,
        borderRadius: 8,
        padding: '12px 14px',
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: accent.label,
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        {hasErrors ? '⚠ Review before submitting' : '⚠ Worth a glance'}
        <span className="muted" style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          {errors.length > 0 && `${errors.length} error${errors.length === 1 ? '' : 's'}`}
          {errors.length > 0 && warnings.length > 0 && ', '}
          {warnings.length > 0 && `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>
        {alerts.map((a, i) => (
          <li
            key={i}
            style={{
              color: a.severity === 'error' ? '#991b1b' : '#92400e',
              marginBottom: i < alerts.length - 1 ? 4 : 0,
            }}
          >
            <span style={{ fontWeight: 600, marginRight: 6 }}>
              {a.severity === 'error' ? '●' : '○'}
            </span>
            {a.message}
          </li>
        ))}
      </ul>
    </div>
  );
}


// Documents attached to this pay app. Uploads default to auto-attach (server
// links new docs to the active Owner draft pay app for this project) — but
// when uploading from the pay-app detail page we pin pay_app_id explicitly so
// the doc lands HERE regardless of which Owner draft is active. Users can
// detach without deleting via the unlink button.
function PayAppDocumentsSection({ payAppId, projectId, editable }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listDocuments({ pay_app_id: payAppId });
      setDocs(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [payAppId]);

  useEffect(() => { load(); }, [load]);

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadDocument({
        file,
        project_id: projectId,
        pay_app_id: payAppId, // pin explicitly to this pay app
      });
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setUploading(false);
      // Reset the input so re-uploading the same filename triggers onChange.
      e.target.value = '';
    }
  }

  async function detach(docId) {
    if (!confirm('Detach this document from the pay app? The file stays in the project, just not linked here.')) return;
    try {
      await api.updateDocument(docId, { pay_app_id: 'none' });
      await load();
    } catch (e) {
      alert(e.message);
    }
  }

  async function remove(docId) {
    if (!confirm('Delete this document permanently? This cannot be undone.')) return;
    try {
      await api.deleteDocument(docId);
      await load();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <div className="section">
      <div className="section-header">
        <h3>Attached documents</h3>
        {editable && (
          <label className="btn-secondary btn-sm" style={{ cursor: uploading ? 'wait' : 'pointer' }}>
            {uploading ? 'Uploading…' : '📎 Attach file'}
            <input
              type="file"
              style={{ display: 'none' }}
              onChange={handleUpload}
              disabled={uploading}
            />
          </label>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="muted" style={{ padding: '12px 0' }}>
          No documents attached. Upload receipts, photos, or invoices and they’ll travel with this pay app.
        </div>
      ) : (
        <table className="vendors-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Category</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th style={{ width: 160 }}></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>
                  <a
                    href={api.documentUrl(d.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {d.filename}
                  </a>
                </td>
                <td className="muted">{d.category || '—'}</td>
                <td className="muted">{formatBytes(d.size_bytes)}</td>
                <td className="muted">{d.created_at?.slice(0, 10) || '—'}</td>
                <td className="col-action" style={{ textAlign: 'right' }}>
                  <a
                    href={api.documentUrl(d.id, { download: true })}
                    className="btn-icon"
                    title="Download"
                    style={{ marginRight: 4 }}
                  >
                    ⬇
                  </a>
                  {editable && (
                    <>
                      <button
                        className="btn-icon"
                        onClick={() => detach(d.id)}
                        title="Detach from pay app (keep in project)"
                        style={{ marginRight: 4 }}
                      >
                        🔗
                      </button>
                      <button
                        className="btn-icon"
                        onClick={() => remove(d.id)}
                        title="Delete permanently"
                      >
                        ×
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Format bytes as a human-friendly string. Used by the docs table.
function formatBytes(n) {
  if (n == null || n === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
