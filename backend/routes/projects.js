// Projects + nested budget endpoints
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

const PROJECT_FIELDS = [
  'code', 'name', 'address', 'status',
  'contract_amount', 'start_date', 'end_date', 'notes'
];

// ============================================================
// PROJECTS
// ============================================================

// GET /api/projects  — list w/ budget total rolled up
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      p.*,
      COALESCE((
        SELECT SUM(budgeted_amount) FROM budget_lines WHERE project_id = p.id
      ), 0) AS budget_total,
      COALESCE((
        SELECT COUNT(*) FROM budget_lines WHERE project_id = p.id
      ), 0) AS budget_line_count,
      COALESCE((
        SELECT SUM(amount) FROM change_orders
        WHERE project_id = p.id
          AND subcontractor_id IS NULL
          AND status = 'approved'
      ), 0) AS approved_co_total
    FROM projects p
    ORDER BY p.created_at DESC
  `).all();
  // Compute revised contract = original + approved owner-side COs
  res.json(rows.map((r) => ({
    ...r,
    revised_contract: (Number(r.contract_amount) || 0) + Number(r.approved_co_total || 0),
  })));
});

// GET /api/projects/:id  — single project
router.get('/:id', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const coTotal = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM change_orders
    WHERE project_id = ? AND subcontractor_id IS NULL AND status = 'approved'
  `).get(req.params.id);
  res.json({
    ...project,
    approved_co_total: coTotal.total,
    revised_contract: (Number(project.contract_amount) || 0) + Number(coTotal.total || 0),
  });
});

// POST /api/projects  — create
router.post('/', (req, res) => {
  const db = getDb();
  const { code, name } = req.body;
  if (!code || !name) {
    return res.status(400).json({ error: 'code and name are required' });
  }
  try {
    const info = db.prepare(`
      INSERT INTO projects (code, name, address, status, contract_amount, start_date, end_date, notes)
      VALUES (@code, @name, @address, COALESCE(@status, 'active'), @contract_amount, @start_date, @end_date, @notes)
    `).run({
      code,
      name,
      address: req.body.address ?? null,
      status: req.body.status ?? null,
      contract_amount: req.body.contract_amount ?? null,
      start_date: req.body.start_date ?? null,
      end_date: req.body.end_date ?? null,
      notes: req.body.notes ?? null,
    });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(project);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `Project code "${code}" already exists` });
    }
    throw e;
  }
});

// PATCH /api/projects/:id  — partial update
router.patch('/:id', (req, res) => {
  const db = getDb();
  const updates = [];
  const values = {};
  for (const f of PROJECT_FIELDS) {
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
  try {
    const result = db.prepare(
      `UPDATE projects SET ${updates.join(', ')} WHERE id = @id`
    ).run(values);
    if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    res.json(project);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `Project code already exists` });
    }
    throw e;
  }
});

// DELETE /api/projects/:id  — cascades budget lines
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true, deleted: Number(req.params.id) });
});

// ============================================================
// BUDGET LINES (nested under projects)
// ============================================================

// GET /api/projects/:id/budget  — list lines for project
router.get('/:id/budget', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const rows = db.prepare(`
    SELECT * FROM budget_lines
    WHERE project_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(req.params.id);
  res.json(rows);
});

// POST /api/projects/:id/budget  — create a line
router.post('/:id/budget', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { cost_code, description } = req.body;
  if (!cost_code || !description) {
    return res.status(400).json({ error: 'cost_code and description are required' });
  }

  const info = db.prepare(`
    INSERT INTO budget_lines (project_id, cost_code, category, description, budgeted_amount, sort_order, notes)
    VALUES (@project_id, @cost_code, @category, @description, @budgeted_amount, @sort_order, @notes)
  `).run({
    project_id: req.params.id,
    cost_code,
    category: req.body.category ?? null,
    description,
    budgeted_amount: req.body.budgeted_amount ?? 0,
    sort_order: req.body.sort_order ?? 0,
    notes: req.body.notes ?? null,
  });

  const line = db.prepare('SELECT * FROM budget_lines WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(line);
});

// POST /api/projects/:id/budget/bulk  — replace ALL budget lines for project
// Useful for spreadsheet imports or "save budget" actions in the UI.
router.post('/:id/budget/bulk', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { lines } = req.body;
  if (!Array.isArray(lines)) {
    return res.status(400).json({ error: 'Body must include a "lines" array' });
  }

  const insert = db.prepare(`
    INSERT INTO budget_lines (project_id, cost_code, category, description, budgeted_amount, sort_order, notes)
    VALUES (@project_id, @cost_code, @category, @description, @budgeted_amount, @sort_order, @notes)
  `);
  const wipe = db.prepare('DELETE FROM budget_lines WHERE project_id = ?');

  const tx = db.transaction((projectId, rows) => {
    wipe.run(projectId);
    rows.forEach((l, idx) => {
      if (!l.cost_code || !l.description) {
        throw new Error(`Row ${idx}: cost_code and description required`);
      }
      insert.run({
        project_id: projectId,
        cost_code: l.cost_code,
        category: l.category ?? null,
        description: l.description,
        budgeted_amount: l.budgeted_amount ?? 0,
        sort_order: l.sort_order ?? idx,
        notes: l.notes ?? null,
      });
    });
  });

  try {
    tx(req.params.id, lines);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const result = db.prepare(`
    SELECT * FROM budget_lines WHERE project_id = ? ORDER BY sort_order ASC, id ASC
  `).all(req.params.id);
  res.json(result);
});

module.exports = router;
