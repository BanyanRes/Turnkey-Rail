// Budget Modifications / Allocations CRUD
//
// Dev managers use this to track budget changes on a project: reallocations
// between cost codes, contingency draws, owner-funded increases. Each row is a
// signed dollar change tied to a cost code. The per-cost-code total of
// APPROVED rows rolls up into the "Budget Modifications" column of the project
// Cost Report (see routes/projects.js -> /:id/cost-report).
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

const FIELDS = [
  'project_id', 'cost_code', 'category', 'description',
  'amount', 'kind', 'status', 'mod_date', 'notes',
];

// GET /api/budget-modifications?project_id=&status=  — list, with a rolled-up
// summary the UI shows at the top of the Budget Mods tab.
router.get('/', (req, res) => {
  const db = getDb();
  const where = [];
  const params = {};
  if (req.query.project_id) {
    where.push('bm.project_id = @project_id');
    params.project_id = req.query.project_id;
  }
  if (req.query.status) {
    where.push('bm.status = @status');
    params.status = req.query.status;
  }
  const rows = db.prepare(`
    SELECT bm.*, p.code AS project_code, p.name AS project_name
    FROM budget_modifications bm
    JOIN projects p ON p.id = bm.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY bm.mod_date DESC, bm.id DESC
  `).all(params);

  // Net approved total (what flows into the report) plus a draft total.
  let approvedTotal = 0;
  let draftTotal = 0;
  for (const r of rows) {
    if (r.status === 'approved') approvedTotal += Number(r.amount || 0);
    else draftTotal += Number(r.amount || 0);
  }
  res.json({ rows, summary: { approved_total: approvedTotal, draft_total: draftTotal, count: rows.length } });
});

// GET /api/budget-modifications/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT bm.*, p.code AS project_code, p.name AS project_name
    FROM budget_modifications bm
    JOIN projects p ON p.id = bm.project_id
    WHERE bm.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Budget modification not found' });
  res.json(row);
});

// POST /api/budget-modifications — create
router.post('/', (req, res) => {
  const db = getDb();
  const { project_id, cost_code, description } = req.body;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });
  if (!cost_code || !String(cost_code).trim()) {
    return res.status(400).json({ error: 'cost_code is required' });
  }
  if (!description || !String(description).trim()) {
    return res.status(400).json({ error: 'description is required' });
  }
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const info = db.prepare(`
    INSERT INTO budget_modifications
      (project_id, cost_code, category, description, amount, kind, status, mod_date, notes)
    VALUES
      (@project_id, @cost_code, @category, @description, @amount,
       COALESCE(@kind, 'modification'), COALESCE(@status, 'approved'), @mod_date, @notes)
  `).run({
    project_id,
    cost_code: String(cost_code).trim(),
    category: req.body.category ?? null,
    description: String(description).trim(),
    amount: req.body.amount ?? 0,
    kind: req.body.kind ?? null,
    status: req.body.status ?? null,
    mod_date: req.body.mod_date ?? null,
    notes: req.body.notes ?? null,
  });
  const row = db.prepare('SELECT * FROM budget_modifications WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

// PATCH /api/budget-modifications/:id
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
    `UPDATE budget_modifications SET ${updates.join(', ')} WHERE id = @id`
  ).run(values);
  if (result.changes === 0) return res.status(404).json({ error: 'Budget modification not found' });
  const row = db.prepare('SELECT * FROM budget_modifications WHERE id = ?').get(req.params.id);
  res.json(row);
});

// DELETE /api/budget-modifications/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM budget_modifications WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Budget modification not found' });
  res.json({ ok: true, deleted: Number(req.params.id) });
});

module.exports = router;
