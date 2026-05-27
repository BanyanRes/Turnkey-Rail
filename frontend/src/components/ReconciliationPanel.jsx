import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { fmtMoney } from '../utils';

// Owner-billed vs sub-owed reconciliation for a single project. Cumulative
// figures always show; a month picker enables the "this period" column,
// which only counts pay apps whose period_end falls in that month.
//
// Margin = owner billed − sub owed. Negative margin on cumulative usually
// means subs are doing work the owner hasn't been billed for yet (or the
// owner-side pay app cycle is behind).
export default function ReconciliationPanel({ projectId }) {
  // Default the picker to the current month so this view is useful on first open.
  const today = new Date();
  const defaultPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const [period, setPeriod] = useState(defaultPeriod);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getProjectReconciliation(projectId, period);
      setData(result);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, period]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <div className="muted" style={{ marginTop: 24 }}>Loading reconciliation…</div>;
  if (error) return <div className="error" style={{ marginTop: 24 }}>{error}</div>;
  if (!data) return null;

  const ownerRows = data.rows.filter((r) => r.side === 'owner');
  const subRows = data.rows.filter((r) => r.side === 'sub');
  const marginPos = data.margin.cumulative >= 0;
  const marginThisPos = data.margin.this_period >= 0;

  return (
    <div className="reconciliation-panel" style={{ marginTop: 32 }}>
      <div className="section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Reconciliation</h3>
        <div className="filter-bar" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: 13 }}>Period:</label>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="inline-input"
            style={{ width: 140 }}
          />
        </div>
      </div>

      {/* Summary cards: owner vs sub vs margin. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 }}>
        <SummaryCard
          title="Owner billed"
          subtitle="To the property owner"
          cumulative={data.owner.billed_cumulative}
          thisPeriod={data.owner.this_period_due}
          outstanding={data.owner.outstanding}
        />
        <SummaryCard
          title="Sub owed"
          subtitle="To subcontractors"
          cumulative={data.sub.billed_cumulative}
          thisPeriod={data.sub.this_period_due}
          outstanding={data.sub.outstanding}
        />
        <div className="summary-panel" style={{ background: marginPos ? '#ecfdf5' : '#fef2f2', borderColor: marginPos ? '#10b981' : '#ef4444' }}>
          <div style={{ fontSize: 13, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Margin
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Owner billed − Sub owed</div>
          <div className="summary-row">
            <span>Cumulative</span>
            <span className={`amount-cell strong ${marginPos ? '' : 'cell-bad'}`}>{fmtMoney(data.margin.cumulative)}</span>
          </div>
          <div className="summary-row">
            <span>This period ({period})</span>
            <span className={`amount-cell ${marginThisPos ? '' : 'cell-bad'}`}>{fmtMoney(data.margin.this_period)}</span>
          </div>
        </div>
      </div>

      {/* Detail tables, side by side. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <SideTable title="Owner billings" rows={ownerRows} emptyMsg="No owner billings yet. Use Pay Apps tab → ⟳ Start next cycle (Owner side)." period={period} />
        <SideTable title="Sub pay apps" rows={subRows} emptyMsg="No sub pay apps yet." period={period} />
      </div>
    </div>
  );
}

function SummaryCard({ title, subtitle, cumulative, thisPeriod, outstanding }) {
  return (
    <div className="summary-panel">
      <div style={{ fontSize: 13, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {title}
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{subtitle}</div>
      <div className="summary-row">
        <span>Cumulative</span>
        <span className="amount-cell strong">{fmtMoney(cumulative)}</span>
      </div>
      <div className="summary-row">
        <span>This period due</span>
        <span className="amount-cell">{fmtMoney(thisPeriod)}</span>
      </div>
      <div className="summary-row">
        <span className="muted">Outstanding (not paid)</span>
        <span className="amount-cell muted">{fmtMoney(outstanding)}</span>
      </div>
    </div>
  );
}

function SideTable({ title, rows, emptyMsg, period }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {rows.length === 0 ? (
        <div className="empty-state" style={{ padding: 16, fontSize: 13 }}>{emptyMsg}</div>
      ) : (
        <table className="vendors-table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>To</th>
              <th>Period</th>
              <th>Status</th>
              <th className="amount-th">Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pay_app_id} className={r.period_end && r.period_end.startsWith(period) ? 'row-highlight' : ''}>
                <td className="strong">#{r.app_number}</td>
                <td>{r.subcontractor_name || <span className="badge-owner">Owner</span>}</td>
                <td className="muted">{r.period_end || '—'}</td>
                <td><span className={`status status-${r.status}`}>{r.status}</span></td>
                <td className="amount-cell">{fmtMoney(r.current_due)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
