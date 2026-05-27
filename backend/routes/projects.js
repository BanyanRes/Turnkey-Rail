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

// =============================================================
// Reconciliation: owner billed vs sub owed, per project.
//
// The point: a GC bills the owner on one side, pays subs on the other,
// and the difference is margin. Until now those two sides have lived in
// separate pay apps with no shared view. This endpoint joins them.
//
// Optional ?period=YYYY-MM filters pay apps whose period_end falls in
// that month. Without it, "this period" rows are skipped and only
// cumulative numbers are returned.
// =============================================================
router.get('/:id/reconciliation', (req, res) => {
  const db = getDb();
  const projectId = Number(req.params.id);
  const period = req.query.period; // 'YYYY-MM' or undefined

  const project = db.prepare(
    'SELECT id, code, name, contract_amount FROM projects WHERE id = ?'
  ).get(projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  // Pull every pay app for this project with line totals computed inline.
  // We re-derive totals here instead of importing withTotals from
  // payApplications.js to avoid a cross-route require cycle.
  const payApps = db.prepare(`
    SELECT
      pa.id, pa.app_number, pa.subcontractor_id, pa.status,
      pa.period_start, pa.period_end, pa.retainage_pct,
      pa.contract_sum, pa.change_orders,
      s.name AS subcontractor_name, s.trade AS subcontractor_trade,
      COALESCE((
        SELECT SUM(completed_previous + completed_this_period + stored_materials)
        FROM pay_app_lines WHERE pay_app_id = pa.id
      ), 0) AS total_completed,
      COALESCE((
        SELECT SUM(completed_this_period)
        FROM pay_app_lines WHERE pay_app_id = pa.id
      ), 0) AS this_period_total,
      COALESCE((
        SELECT SUM(completed_previous)
        FROM pay_app_lines WHERE pay_app_id = pa.id
      ), 0) AS prior_total
    FROM pay_applications pa
    LEFT JOIN subcontractors s ON s.id = pa.subcontractor_id
    WHERE pa.project_id = ?
    ORDER BY pa.subcontractor_id IS NULL DESC, s.name ASC, pa.app_number ASC
  `).all(projectId);

  // Derive each pay app's billed/due figures (net of retainage), and a flag
  // for whether it falls inside the requested period.
  const inPeriod = (pe) => {
    if (!period || !pe) return false;
    return String(pe).startsWith(period); // pe is yyyy-mm-dd
  };

  const rows = payApps.map((p) => {
    const retPct = Number(p.retainage_pct || 0) / 100;
    const total = Number(p.total_completed || 0);
    const prior = Number(p.prior_total || 0);
    const earnedLessRet = total * (1 - retPct);
    const priorNet = prior * (1 - retPct);
    const currentDue = earnedLessRet - priorNet;
    return {
      pay_app_id: p.id,
      app_number: p.app_number,
      side: p.subcontractor_id == null ? 'owner' : 'sub',
      subcontractor_id: p.subcontractor_id,
      subcontractor_name: p.subcontractor_name,
      subcontractor_trade: p.subcontractor_trade,
      status: p.status,
      period_start: p.period_start,
      period_end: p.period_end,
      contract_sum: Number(p.contract_sum || 0),
      change_orders: Number(p.change_orders || 0),
      revised_contract: Number(p.contract_sum || 0) + Number(p.change_orders || 0),
      total_completed: total,
      earned_less_retainage: earnedLessRet,
      current_due: currentDue,
      this_period_total: Number(p.this_period_total || 0),
      in_period: inPeriod(p.period_end),
    };
  });

  // Aggregate by side. "billed_cumulative" = earned less retainage (what the
  // payer owes us / we owe them once retainage releases). "this_period_due" =
  // only pay apps whose period_end is inside ?period.
  const sumOwner = { billed_cumulative: 0, this_period_due: 0, outstanding: 0 };
  const sumSub = { billed_cumulative: 0, this_period_due: 0, outstanding: 0 };
  for (const r of rows) {
    const bucket = r.side === 'owner' ? sumOwner : sumSub;
    bucket.billed_cumulative += r.earned_less_retainage;
    if (r.in_period) bucket.this_period_due += r.current_due;
    if (r.status !== 'paid') bucket.outstanding += r.current_due;
  }

  res.json({
    project: {
      id: project.id,
      code: project.code,
      name: project.name,
      contract_amount: Number(project.contract_amount || 0),
    },
    period: period || null,
    owner: sumOwner,
    sub: sumSub,
    margin: {
      cumulative: sumOwner.billed_cumulative - sumSub.billed_cumulative,
      this_period: sumOwner.this_period_due - sumSub.this_period_due,
    },
    rows,
  });
});

module.exports = router;
