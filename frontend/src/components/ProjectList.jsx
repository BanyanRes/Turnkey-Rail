import { fmtMoney } from '../utils';

export default function ProjectList({ projects, selectedId, onSelect, loading, error }) {
  if (loading) return <div className="muted p-md">Loading…</div>;
  if (error) return <div className="error p-md">{error}</div>;
  if (projects.length === 0) {
    return <div className="muted p-md">No projects yet. Click "+ New Project" to start.</div>;
  }
  return (
    <ul className="project-list">
      {projects.map((p) => (
        <li
          key={p.id}
          className={`project-row ${p.id === selectedId ? 'selected' : ''}`}
          onClick={() => onSelect(p.id)}
        >
          <div className="row-top">
            <span className="code">{p.code}</span>
            <span className={`status status-${p.status}`}>{p.status.replace('_', ' ')}</span>
          </div>
          <div className="name">{p.name}</div>
          <div className="row-bottom">
            <span className="muted">
              {p.budget_line_count} line{p.budget_line_count === 1 ? '' : 's'}
            </span>
            <span className="amount">{fmtMoney(p.budget_total)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
