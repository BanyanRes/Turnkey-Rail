import { fmtMoney } from '../utils';
import BudgetTable from './BudgetTable';

export default function ProjectDetail({ project, onChange, onDelete, editable = true }) {
  const hasCOs = Number(project.approved_co_total || 0) !== 0;

  return (
    <div className="project-detail">
      <div className="detail-header">
        <div className="detail-title">
          <div className="muted code-label">{project.code}</div>
          <h2>{project.name}</h2>
          {project.address && <div className="muted">{project.address}</div>}
        </div>
        <div className="header-meta">
          {hasCOs ? (
            <>
              <div className="meta-item">
                <div className="label">Original contract</div>
                <div className="muted" style={{ fontSize: 14 }}>
                  {fmtMoney(project.contract_amount)}
                </div>
              </div>
              <div className="meta-item">
                <div className="label">Approved COs</div>
                <div className={Number(project.approved_co_total) < 0 ? 'cell-bad' : ''} style={{ fontSize: 14 }}>
                  {Number(project.approved_co_total) > 0 ? '+' : ''}{fmtMoney(project.approved_co_total)}
                </div>
              </div>
              <div className="meta-item">
                <div className="label">Revised contract</div>
                <div className="amount">{fmtMoney(project.revised_contract)}</div>
              </div>
            </>
          ) : (
            <div className="meta-item">
              <div className="label">Contract</div>
              <div className="amount">{fmtMoney(project.contract_amount)}</div>
            </div>
          )}
          <div className="meta-item">
            <div className="label">Status</div>
            <div className={`status status-${project.status}`}>
              {project.status.replace('_', ' ')}
            </div>
          </div>
          {editable && <button className="btn-danger" onClick={onDelete}>Delete</button>}
        </div>
      </div>

      <BudgetTable projectId={project.id} onTotalsChange={onChange} editable={editable} />
    </div>
  );
}
