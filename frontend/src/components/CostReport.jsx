import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { fmtMoney } from '../utils';

// Mirrors the "Summary" tab of the Turnkey Rail Budget Projection Report:
// one row per budget line, grouped by category with subtotals and a grand
// total, carrying all 18 columns. Read-only — the numbers come from the
// budget, Budget Mods tab, change orders, sub pay apps, and CloudLedger.
export default function CostReport({ projectId }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const data = await api.getCostReport(projectId);
      setReport(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Only fetch once the section is expanded (it's a wide, heavier query).
  useEffect(() => {
    if (open && !report) load();
  }, [open, report, load]);

  // Reset when switching projects.
  useEffect(() => { setReport(null); }, [projectId]);

  const columns = report?.columns || [];

  const fmtCell = (col, value) => {
    if (col.percent) {
      const pct = Number(value || 0) * 100;
      return `${pct.toFixed(1)}%`;
    }
    return fmtMoney(value, { dash: false });
  };

  const cellClass = (col, value) => {
    const n = Number(value || 0);
    if (col.key === 'balance_to_fund' && n < 0) return 'cell-bad';
    if (col.key === 'buyout_savings' && n < 0) return 'cell-bad';
    if (col.key === 'buyout_savings' && n > 0) return 'cell-good';
    if (col.key === 'open_commitment' && n < 0) return 'cell-bad';
    return '';
  };

  return (
    <section className="cost-report">
      <div className="cost-report-head" style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0 8px' }}>
        <button className="btn-secondary" onClick={() => setOpen((v) => !v)}>
          {open ? '▾ Cost Report' : '▸ Cost Report'}
        </button>
        {open && report && (
          <span className="muted" style={{ fontSize: 13 }}>
            As of {report.as_of}
            {report.direct_costs && !report.direct_costs.available && (
              <span title={report.direct_costs.note || ''} style={{ marginLeft: 10, color: '#b45309' }}>
                · Direct Costs pending CloudLedger
              </span>
            )}
          </span>
        )}
        {open && (
          <button className="btn-secondary" onClick={load} disabled={loading} style={{ marginLeft: 'auto' }}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {open && (
        <>
          {loading && !report && <div className="muted">Loading cost report…</div>}
          {error && <div className="cell-bad">Failed to load: {error}</div>}
          {report && (
            <div className="cost-report-scroll" style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <table className="cost-report-table" style={{ borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
                <thead>
                  <tr>
                    <th style={thSticky(0, 190)}>Cost Code / Description</th>
                    {columns.map((c) => (
                      <th key={c.key} style={thNum(c.computed)} title={c.label}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.categories.map((cat) => (
                    <CategoryBlock
                      key={cat.category}
                      cat={cat}
                      columns={columns}
                      fmtCell={fmtCell}
                      cellClass={cellClass}
                    />
                  ))}
                  {/* Grand total */}
                  <tr className="cr-grand" style={{ background: '#111827', color: '#fff', fontWeight: 700 }}>
                    <td style={tdSticky('#111827', '#fff')}>Total Project Costs</td>
                    {columns.map((c) => (
                      <td key={c.key} style={tdNum()}>
                        {fmtCell(c, report.grand_total[c.key])}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CategoryBlock({ cat, columns, fmtCell, cellClass }) {
  return (
    <>
      {cat.rows.map((row) => (
        <tr key={row.budget_line_id ?? `unalloc-${cat.category}`} className="cr-row">
          <td style={tdSticky('#fff')}>
            <span className="muted" style={{ marginRight: 8 }}>{row.cost_code}</span>
            {row.description}
          </td>
          {columns.map((c) => (
            <td key={c.key} style={tdNum()} className={cellClass(c, row[c.key])}>
              {fmtCell(c, row[c.key])}
            </td>
          ))}
        </tr>
      ))}
      <tr className="cr-subtotal" style={{ background: '#f3f4f6', fontWeight: 600 }}>
        <td style={tdSticky('#f3f4f6')}>{cat.subtotal.description}</td>
        {columns.map((c) => (
          <td key={c.key} style={tdNum()}>{fmtCell(c, cat.subtotal[c.key])}</td>
        ))}
      </tr>
    </>
  );
}

// --- inline style helpers (kept local so the component is drop-in) ---
function thSticky(left, width) {
  return {
    position: 'sticky', left, zIndex: 2, background: '#f9fafb',
    textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #e5e7eb',
    minWidth: width, boxShadow: '2px 0 0 #e5e7eb',
  };
}
function thNum(computed) {
  return {
    textAlign: 'right', padding: '8px 10px', borderBottom: '2px solid #e5e7eb',
    minWidth: 104, background: computed ? '#eef2ff' : '#f9fafb', fontWeight: 600,
  };
}
function tdSticky(bg, color) {
  return {
    position: 'sticky', left: 0, zIndex: 1, background: bg, color: color || 'inherit',
    textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #f1f5f9',
    boxShadow: '2px 0 0 #e5e7eb',
  };
}
function tdNum() {
  return { textAlign: 'right', padding: '6px 10px', borderBottom: '1px solid #f1f5f9', fontVariantNumeric: 'tabular-nums' };
}
