import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api';
import { canEdit } from '../permissions';

// ============================================================
// Date helpers
// ============================================================
function parseISO(s) {
  if (!s) return null;
  // SQLite returns "yyyy-mm-dd" — construct as UTC midnight to avoid TZ drift
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}
function toISO(d) {
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}
function fmtDateShort(iso) {
  if (!iso) return '—';
  return iso.slice(5); // mm-dd
}

// ============================================================
// Main view
// ============================================================
export default function ScheduleView({ me }) {
  const editable = canEdit(me, 'schedule');
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [subs, setSubs] = useState([]);

  useEffect(() => {
    Promise.all([
      api.listProjects(),
      api.listSubs({ status: 'active' }),
    ]).then(([ps, ss]) => {
      setProjects(ps);
      setSubs(ss);
      setProjectId((prev) => prev ?? ps[0]?.id ?? null);
      setLoading(false);
    }).catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api.listTasks(projectId);
      setTasks(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const project = projects.find((p) => p.id === projectId) || null;

  async function handleSaveTask(id, patch) {
    await api.updateTask(id, patch);
    await refresh();
  }
  async function handleDeleteTask(t) {
    if (!confirm(`Delete "${t.name}"?`)) return;
    await api.deleteTask(t.id);
    await refresh();
  }
  async function handleCreateTask(data) {
    await api.createTask({ ...data, project_id: projectId });
    setShowNew(false);
    await refresh();
  }

  if (loading) return <div className="vendors-main muted">Loading…</div>;

  return (
    <>
      <div className="view-toolbar">
        <div className="filter-bar">
          <select
            className="select-input"
            value={projectId || ''}
            onChange={(e) => setProjectId(Number(e.target.value) || null)}
          >
            <option value="">— Select project —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
            ))}
          </select>
        </div>
        {editable && project && (
          <button className="btn-primary" onClick={() => setShowNew(true)}>+ New Task</button>
        )}
      </div>

      <main className="vendors-main">
        {error && <div className="error">{error}</div>}

        {!project ? (
          <div className="empty-state">Select a project to view its schedule.</div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">
            No tasks yet for {project.code}.{editable ? ' Click "+ New Task" to start.' : ''}
          </div>
        ) : (
          <>
            <GanttChart project={project} tasks={tasks} />
            <TaskTable
              tasks={tasks}
              subs={subs}
              onSave={handleSaveTask}
              onDelete={handleDeleteTask}
              editable={editable}
            />
          </>
        )}

        {showNew && project && (
          <NewTaskForm
            project={project}
            subs={subs}
            onCreate={handleCreateTask}
            onCancel={() => setShowNew(false)}
          />
        )}
      </main>
    </>
  );
}

// ============================================================
// Gantt
// ============================================================
function GanttChart({ project, tasks }) {
  const { rangeStart, rangeEnd, totalDays, monthMarkers, today } = useMemo(() => {
    // Collect all dates we know about
    const dates = [];
    if (project.start_date) dates.push(parseISO(project.start_date));
    if (project.end_date) dates.push(parseISO(project.end_date));
    tasks.forEach((t) => {
      if (t.start_date) dates.push(parseISO(t.start_date));
      if (t.end_date) dates.push(parseISO(t.end_date));
    });
    const valid = dates.filter(Boolean);
    let rs, re;
    if (valid.length === 0) {
      rs = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      re = addDays(rs, 60);
    } else {
      rs = new Date(Math.min(...valid.map((d) => d.getTime())));
      re = new Date(Math.max(...valid.map((d) => d.getTime())));
      // Pad a bit on each end
      rs = addDays(rs, -3);
      re = addDays(re, 3);
    }
    const total = Math.max(1, daysBetween(rs, re));

    // Month markers
    const markers = [];
    const cur = new Date(Date.UTC(rs.getUTCFullYear(), rs.getUTCMonth(), 1));
    while (cur <= re) {
      const offset = daysBetween(rs, cur);
      if (offset >= 0 && offset <= total) {
        markers.push({
          pct: (offset / total) * 100,
          label: cur.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
        });
      }
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }

    // Today
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayPct = today >= rs && today <= re ? (daysBetween(rs, today) / total) * 100 : null;

    return { rangeStart: rs, rangeEnd: re, totalDays: total, monthMarkers: markers, today: todayPct };
  }, [project, tasks]);

  return (
    <div className="gantt-wrap">
      <div className="gantt-scroller">
        <div className="gantt-header">
          {monthMarkers.map((m, i) => (
            <div
              key={i}
              className="gantt-month"
              style={{ left: `${m.pct}%` }}
            >
              {m.label}
            </div>
          ))}
          {today != null && (
            <div className="gantt-today-label" style={{ left: `${today}%` }}>
              today
            </div>
          )}
        </div>

        <div className="gantt-rows">
          {today != null && (
            <div className="gantt-today-line" style={{ left: `${today}%` }} />
          )}
          {monthMarkers.map((m, i) => (
            <div
              key={i}
              className="gantt-month-grid"
              style={{ left: `${m.pct}%` }}
            />
          ))}
          {tasks.map((t) => (
            <GanttBar
              key={t.id}
              task={t}
              rangeStart={rangeStart}
              totalDays={totalDays}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function GanttBar({ task, rangeStart, totalDays }) {
  const start = parseISO(task.start_date);
  const end = parseISO(task.end_date);
  if (!start || !end || end < start) {
    return (
      <div className="gantt-row">
        <div className="gantt-row-label muted">{task.name}</div>
        <div className="gantt-row-track">
          <div className="gantt-bar-missing">no dates</div>
        </div>
      </div>
    );
  }
  const leftPct = (daysBetween(rangeStart, start) / totalDays) * 100;
  const widthDays = Math.max(1, daysBetween(start, end));
  const widthPct = (widthDays / totalDays) * 100;
  const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));

  return (
    <div className="gantt-row">
      <div className="gantt-row-label">{task.name}</div>
      <div className="gantt-row-track">
        <div
          className="gantt-bar"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          title={`${task.name} · ${task.start_date} → ${task.end_date} · ${progress}%`}
        >
          <div className="gantt-bar-fill" style={{ width: `${progress}%` }} />
          <span className="gantt-bar-label">{progress}%</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Task table (with inline editing for dates + progress)
// ============================================================
function TaskTable({ tasks, subs, onSave, onDelete, editable = true }) {
  return (
    <div className="task-table-wrap">
      <div className="section-header">
        <h3>Tasks</h3>
      </div>
      <table className="vendors-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Assignee</th>
            <th>Start</th>
            <th>End</th>
            <th className="amount-th">Progress</th>
            {editable && <th></th>}
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td className="strong">{t.name}</td>
              <td className="muted">{t.subcontractor_name || '—'}</td>
              <td>
                <input
                  type="date"
                  className="cell-date"
                  defaultValue={t.start_date || ''}
                  disabled={!editable}
                  onBlur={(e) => {
                    const v = e.target.value || null;
                    if (v !== (t.start_date || null)) onSave(t.id, { start_date: v });
                  }}
                />
              </td>
              <td>
                <input
                  type="date"
                  className="cell-date"
                  defaultValue={t.end_date || ''}
                  disabled={!editable}
                  onBlur={(e) => {
                    const v = e.target.value || null;
                    if (v !== (t.end_date || null)) onSave(t.id, { end_date: v });
                  }}
                />
              </td>
              <td className="amount-cell">
                {editable ? (
                  <ProgressEdit value={t.progress} onSave={(v) => onSave(t.id, { progress: v })} />
                ) : (
                  <span>{t.progress || 0}%</span>
                )}
              </td>
              {editable && (
                <td className="col-action">
                  <button className="btn-icon" title="Delete" onClick={() => onDelete(t)}>×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProgressEdit({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? 0));
  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        min="0" max="100" step="5"
        className="inline-input"
        style={{ width: 60 }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={async () => {
          const n = Math.max(0, Math.min(100, Number(draft) || 0));
          if (n !== Number(value)) await onSave(n);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') { setDraft(String(value ?? 0)); setEditing(false); }
        }}
      />
    );
  }
  return (
    <span className="inline-editable" onClick={() => { setDraft(String(value ?? 0)); setEditing(true); }}>
      {value || 0}%
    </span>
  );
}

// ============================================================
// New task form
// ============================================================
function NewTaskForm({ project, subs, onCreate, onCancel }) {
  const [form, setForm] = useState({
    name: '',
    subcontractor_id: '',
    start_date: project.start_date || '',
    end_date: '',
    progress: 0,
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) return setError('Name is required');
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: form.name.trim(),
        subcontractor_id: form.subcontractor_id ? Number(form.subcontractor_id) : null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        progress: Number(form.progress) || 0,
        notes: form.notes || null,
      });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New Task — {project.code}</h2>

        <label>
          Name *
          <input
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="Foundation pour"
            autoFocus
          />
        </label>

        <label>
          Assignee (vendor)
          <select
            value={form.subcontractor_id}
            onChange={(e) => update('subcontractor_id', e.target.value)}
          >
            <option value="">— None —</option>
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.trade ? ` (${s.trade})` : ''}
              </option>
            ))}
          </select>
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

        <label>
          Progress %
          <input
            type="number"
            min="0" max="100" step="5"
            value={form.progress}
            onChange={(e) => update('progress', e.target.value)}
          />
        </label>

        <label>
          Notes
          <textarea
            rows="3"
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
          />
        </label>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onCancel} className="btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
