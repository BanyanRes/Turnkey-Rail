// Schedule tasks (per project)
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

const FIELDS = [
  'project_id', 'name', 'start_date', 'end_date',
  'progress', 'subcontractor_id', 'sort_order', 'notes'
];

// GET /api/tasks?project_id=N  — list tasks for a project, with vendor name
router.get('/', (req, res) => {
  const db = getDb();
  if (!req.query.project_id) {
    return res.status(400).json({ error: 'project_id is required' });
  }
  const rows = db.prepare(`
    SELECT
      t.*,
      s.name AS subcontractor_name,
      s.trade AS subcontractor_trade
    FROM schedule_tasks t
    LEFT JOIN subcontractors s ON s.id = t.subcontractor_id
    WHERE t.project_id = ?
    ORDER BY
      CASE WHEN t.start_date IS NULL THEN 1 ELSE 0 END,
      t.start_date ASC,
      t.sort_order ASC,
      t.id ASC
  `).all(req.query.project_id);
  res.json(rows);
});

// GET /api/tasks/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Task not found' });
  res.json(row);
});

// POST /api/tasks — create
router.post('/', (req, res) => {
  const db = getDb();
  const { project_id, name } = req.body;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const info = db.prepare(`
    INSERT INTO schedule_tasks
      (project_id, name, start_date, end_date, progress, subcontractor_id, sort_order, notes)
    VALUES
      (@project_id, @name, @start_date, @end_date,
       COALESCE(@progress, 0), @subcontractor_id, @sort_order, @notes)
  `).run({
    project_id,
    name: name.trim(),
    start_date: req.body.start_date || null,
    end_date: req.body.end_date || null,
    progress: req.body.progress ?? 0,
    subcontractor_id: req.body.subcontractor_id ?? null,
    sort_order: req.body.sort_order ?? 0,
    notes: req.body.notes || null,
  });
  const row = db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

// PATCH /api/tasks/:id — partial update
router.patch('/:id', (req, res) => {
  const db = getDb();
  const updates = [];
  const values = {};
  for (const f of FIELDS) {
    if (f in req.body) {
      updates.push(`${f} = @${f}`);
      values[f] = req.body[f];
    }
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }
  updates.push(`updated_at = datetime('now')`);
  values.id = req.params.id;
  const result = db.prepare(
    `UPDATE schedule_tasks SET ${updates.join(', ')} WHERE id = @id`
  ).run(values);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
  const row = db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(req.params.id);
  res.json(row);
});

// DELETE /api/tasks/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM schedule_tasks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true, deleted: Number(req.params.id) });
});

module.exports = router;
