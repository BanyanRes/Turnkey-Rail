// Projects + nested budget endpoints
const express = require('express');
const cloudledger = require('../lib/cloudledger_client');
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
router.post('/', async (req, res) => {
  const db = getDb();
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  // Project codes are auto-assigned as 4-digit sequential numbers (0001, 0002, ...).
  // We take the highest existing purely-numeric 4-digit code and increment it, so
  // legacy non-numeric codes (e.g. "LAKE-001") are ignored and never collide.
  function nextProjectCode() {
    const rows = db.prepare("SELECT code FROM projects").all();
    let max = 0;
    for (const r of rows) {
      if (/^\d{1,}$/.test(r.code)) { const n = parseInt(r.code, 10); if (n > max) max = n; }
    }
    return String(max + 1).padStart(4, '0');
  }
  // Allow an explicit code (back-compat), otherwise auto-generate. Retry on rare collision.
  let code = (req.body.code && String(req.body.code).trim()) || nextProjectCode();
  let project;
  try {
    let attempts = 0;
    while (true) {
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
        project = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
        break; // success
      } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          // If the auto-assigned code collided (e.g. concurrent create), recompute and retry.
          if (!req.body.code && attempts < 5) { attempts++; code = nextProjectCode(); continue; }
          return res.status(409).json({ error: `Project code "${code}" already exists` });
        }
        throw e;
      }
    }
  } catch (e) {
    throw e;
  }

  // Best-effort: link to CloudLedger (creates entity + seeds POC chart of accounts).
  // If CL is offline or unconfigured, the project still creates fine; the link
  // can be retried later via the admin "Link to CloudLedger" action.
  // Total estimated cost = sum of budget (may be 0 if no budget lines yet)
  const budgetRow = db.prepare(
    'SELECT COALESCE(SUM(budgeted_amount), 0) AS total FROM budget_lines WHERE project_id = ?'
  ).get(project.id);
  const r = await cloudledger.trySync('link project ' + project.id, () => cloudledger.linkProject({
    turnkey_project_id: project.id,
    project_code: project.code,
    project_name: project.name,
    contract_amount: project.contract_amount,
    total_estimated_costs: Number(budgetRow.total || 0),
  }));
  if (r.ok && r.result && r.result.project_map && r.result.project_map.cl_entity_id) {
    db.prepare("UPDATE projects SET cloudledger_entity_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(r.result.project_map.cl_entity_id, project.id);
    project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
  }

  res.status(201).json(project);
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

// === CloudLedger admin actions ===

// Manually link an existing project to CloudLedger (idempotent).
// Useful for projects created before integration was enabled, or after a
// previous sync failure.
router.post('/:id/cloudledger/link', async (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!cloudledger.isEnabled()) {
    return res.status(400).json({ error: 'CloudLedger integration is not enabled on this server' });
  }
  try {
    const budgetRow = db.prepare(
      'SELECT COALESCE(SUM(budgeted_amount), 0) AS total FROM budget_lines WHERE project_id = ?'
    ).get(project.id);
    const r = await cloudledger.linkProject({
      turnkey_project_id: project.id,
      project_code: project.code,
      project_name: project.name,
      contract_amount: project.contract_amount,
      total_estimated_costs: Number(budgetRow.total || 0),
    });
    if (r && r.project_map && r.project_map.cl_entity_id) {
      db.prepare("UPDATE projects SET cloudledger_entity_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(r.project_map.cl_entity_id, project.id);
    }
    res.json({ ok: true, project_map: r.project_map });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current CloudLedger mapping for this project.
router.get('/:id/cloudledger/status', async (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!cloudledger.isEnabled()) {
    return res.json({ enabled: false });
  }
  try {
    const map = await cloudledger.getProjectMap(project.id);
    res.json({ enabled: true, linked: true, project_map: map });
  } catch (e) {
    if (/HTTP 404/.test(e.message)) {
      return res.json({ enabled: true, linked: false });
    }
    res.status(500).json({ enabled: true, error: e.message });
  }
});

// Trigger month-end POC recognition for a project.
// Computes total_estimated_costs from the budget, sends to CloudLedger.
//
// Body: { period_end_date: 'YYYY-MM-DD' }
router.post('/:id/cloudledger/month-end-poc', async (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!cloudledger.isEnabled()) {
    return res.status(400).json({ error: 'CloudLedger integration not enabled' });
  }
  const period_end_date = (req.body && req.body.period_end_date) || new Date().toISOString().slice(0, 10);

  // Total estimated costs = sum of budget line budgeted_amount
  const budgetRow = db.prepare(`
    SELECT COALESCE(SUM(budgeted_amount), 0) AS total
    FROM budget_lines WHERE project_id = ?
  `).get(project.id);
  const total_estimated_costs = Number(budgetRow.total || 0);

  // Contract amount comes from the project record
  const contract_amount = Number(project.contract_amount || 0);

  if (total_estimated_costs <= 0 || contract_amount <= 0) {
    return res.status(400).json({
      error: 'Cannot compute POC: project requires contract_amount AND budget lines summing > 0',
      contract_amount, total_estimated_costs,
    });
  }

  try {
    const result = await cloudledger.syncMonthEndPOC({
      turnkey_project_id: project.id,
      period_end_date,
      contract_amount,
      total_estimated_costs,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === WIP Schedule (Job Schedule) endpoints ===
// Both proxy to CloudLedger. Turnkey is the operational system; CloudLedger
// owns the financial truth, so the report is computed there.

router.get('/wip-schedule', async (req, res) => {
  if (!cloudledger.isEnabled()) {
    return res.status(400).json({ error: 'CloudLedger integration not enabled' });
  }
  try {
    const data = await cloudledger.getWipScheduleJson(req.query.as_of);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/wip-schedule.xlsx', async (req, res) => {
  if (!cloudledger.isEnabled()) {
    return res.status(400).json({ error: 'CloudLedger integration not enabled' });
  }
  try {
    const buf = await cloudledger.getWipScheduleXlsxBuffer(req.query.as_of);
    const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="WIP_Schedule_' + asOf + '.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
