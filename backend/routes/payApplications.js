// Pay applications + line items
const express = require('express');
const { getDb } = require('../db/database');
const { renderPayAppPdf } = require('../lib/payAppPdf');

const router = express.Router();

const HEADER_FIELDS = [
  'project_id', 'subcontractor_id', 'app_number',
  'period_start', 'period_end', 'submitted_date',
  'status', 'contract_sum', 'change_orders', 'retainage_pct', 'notes'
];

const LINE_FIELDS = [
  'budget_line_id', 'description',
  'scheduled_value', 'completed_previous',
  'completed_this_period', 'stored_materials', 'sort_order'
];

// Aggregate computed totals onto a header row
function withTotals(db, header) {
  const lines = db.prepare(`
    SELECT * FROM pay_app_lines WHERE pay_app_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(header.id);

  let total_completed = 0;
  let scheduled_total = 0;
  let this_period_total = 0;
  let prior_total = 0;
  let stored_total = 0;
  for (const l of lines) {
    scheduled_total += Number(l.scheduled_value || 0);
    prior_total += Number(l.completed_previous || 0);
    this_period_total += Number(l.completed_this_period || 0);
    stored_total += Number(l.stored_materials || 0);
    total_completed += Number(l.completed_previous || 0) + Number(l.completed_this_period || 0) + Number(l.stored_materials || 0);
  }
  const retainage_pct = Number(header.retainage_pct || 0);
  const retainage_amount = total_completed * retainage_pct / 100;
  const earned_less_retainage = total_completed - retainage_amount;
  // prior payments (net of retainage)
  const prior_net = prior_total * (1 - retainage_pct / 100);
  const current_due = earned_less_retainage - prior_net;

  return {
    ...header,
    line_count: lines.length,
    scheduled_total,
    prior_total,
    this_period_total,
    stored_total,
    total_completed,
    retainage_amount,
    earned_less_retainage,
    current_due,
  };
}

// ============================================================
// PAY APPLICATIONS
// ============================================================

// GET /api/pay-apps — list across all projects, with joins
router.get('/', (req, res) => {
  const db = getDb();
  const where = [];
  const params = {};
  if (req.query.project_id) {
    where.push('pa.project_id = @project_id');
    params.project_id = req.query.project_id;
  }
  if (req.query.subcontractor_id) {
    where.push('pa.subcontractor_id = @subcontractor_id');
    params.subcontractor_id = req.query.subcontractor_id;
  }
  if (req.query.status) {
    where.push('pa.status = @status');
    params.status = req.query.status;
  }
  const sql = `
    SELECT
      pa.*,
      p.code AS project_code,
      p.name AS project_name,
      s.name AS subcontractor_name,
      s.trade AS subcontractor_trade
    FROM pay_applications pa
    JOIN projects p ON p.id = pa.project_id
    LEFT JOIN subcontractors s ON s.id = pa.subcontractor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY pa.submitted_date DESC, pa.id DESC
  `;
  const rows = db.prepare(sql).all(params);
  res.json(rows.map((r) => withTotals(db, r)));
});

// GET /api/pay-apps/:id — single with lines + totals
router.get('/:id', (req, res) => {
  const db = getDb();
  const header = db.prepare(`
    SELECT
      pa.*,
      p.code AS project_code,
      p.name AS project_name,
      s.name AS subcontractor_name,
      s.trade AS subcontractor_trade
    FROM pay_applications pa
    JOIN projects p ON p.id = pa.project_id
    LEFT JOIN subcontractors s ON s.id = pa.subcontractor_id
    WHERE pa.id = ?
  `).get(req.params.id);
  if (!header) return res.status(404).json({ error: 'Pay application not found' });

  const lines = db.prepare(`
    SELECT * FROM pay_app_lines WHERE pay_app_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(req.params.id);

  res.json({ ...withTotals(db, header), lines });
});

// POST /api/pay-apps — create
router.post('/', (req, res) => {
  const db = getDb();
  const { project_id, subcontractor_id } = req.body;
  if (!project_id) {
    return res.status(400).json({ error: 'project_id is required' });
  }

  // Auto-number: next # for this project + vendor combo
  const last = db.prepare(`
    SELECT MAX(app_number) AS max_no FROM pay_applications
    WHERE project_id = ?
      AND (subcontractor_id = ? OR (? IS NULL AND subcontractor_id IS NULL))
  `).get(project_id, subcontractor_id ?? null, subcontractor_id ?? null);
  const app_number = req.body.app_number ?? ((last?.max_no || 0) + 1);

  const info = db.prepare(`
    INSERT INTO pay_applications
      (project_id, subcontractor_id, app_number,
       period_start, period_end, submitted_date,
       status, contract_sum, change_orders, retainage_pct, notes)
    VALUES
      (@project_id, @subcontractor_id, @app_number,
       @period_start, @period_end, @submitted_date,
       COALESCE(@status, 'draft'), COALESCE(@contract_sum, 0),
       COALESCE(@change_orders, 0), COALESCE(@retainage_pct, 10), @notes)
  `).run({
    project_id,
    subcontractor_id: subcontractor_id ?? null,
    app_number,
    period_start: req.body.period_start ?? null,
    period_end: req.body.period_end ?? null,
    submitted_date: req.body.submitted_date ?? null,
    status: req.body.status ?? null,
    contract_sum: req.body.contract_sum ?? null,
    change_orders: req.body.change_orders ?? null,
    retainage_pct: req.body.retainage_pct ?? null,
    notes: req.body.notes ?? null,
  });
  const row = db.prepare('SELECT * FROM pay_applications WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(withTotals(db, row));
});

// POST /api/pay-apps/auto-create — start the next pay-app cycle for a project.
//
// This is the big time-saver for monthly Owner billings (and works for sub
// pay apps too). Behavior:
//
//   1. Look up the LATEST pay app for the given (project_id, subcontractor_id)
//      combo. Pass subcontractor_id=null (or omit) to target Owner pay apps.
//   2. If one exists:
//        - app_number = prior.app_number + 1
//        - period_start = day after prior.period_end (or first of next month
//          if prior period_end is missing)
//        - period_end   = end of that month
//        - Copy every prior line item, with:
//             completed_previous = prior (completed_previous + completed_this_period + stored_materials)
//             completed_this_period = 0  (filled in by user this cycle)
//             stored_materials      = 0  (rolled into completed_previous already)
//        - Carry over: contract_sum, change_orders, retainage_pct
//      If no prior pay app exists:
//        - app_number = 1
//        - Seed line items from project budget_lines (Schedule of Values starter)
//        - period defaults to current month
//
// Returns the new pay app with totals so the UI can navigate straight into it.
router.post('/auto-create', (req, res) => {
  const db = getDb();
  const project_id = Number(req.body.project_id);
  const subcontractor_id = req.body.subcontractor_id == null
    ? null
    : Number(req.body.subcontractor_id);
  if (!project_id) {
    return res.status(400).json({ error: 'project_id is required' });
  }

  const prior = db.prepare(`
    SELECT * FROM pay_applications
    WHERE project_id = ?
      AND (subcontractor_id = ? OR (? IS NULL AND subcontractor_id IS NULL))
    ORDER BY app_number DESC
    LIMIT 1
  `).get(project_id, subcontractor_id, subcontractor_id);

  // Compute next period (best-effort; user can adjust in the UI).
  function nextPeriod() {
    if (prior && prior.period_end) {
      const end = new Date(prior.period_end + 'T00:00:00Z');
      const start = new Date(end);
      start.setUTCDate(end.getUTCDate() + 1);
      const monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      return {
        period_start: start.toISOString().slice(0, 10),
        period_end: monthEnd.toISOString().slice(0, 10),
      };
    }
    // No prior, or prior has no period: default to current calendar month.
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return {
      period_start: start.toISOString().slice(0, 10),
      period_end: end.toISOString().slice(0, 10),
    };
  }
  const { period_start, period_end } = nextPeriod();

  // Run insertion + line seeding in a transaction so a partial failure leaves
  // no orphaned header behind.
  const result = db.transaction(() => {
    const app_number = prior ? prior.app_number + 1 : 1;
    const info = db.prepare(`
      INSERT INTO pay_applications
        (project_id, subcontractor_id, app_number,
         period_start, period_end,
         status, contract_sum, change_orders, retainage_pct, notes)
      VALUES
        (@project_id, @subcontractor_id, @app_number,
         @period_start, @period_end,
         'draft', @contract_sum, @change_orders, @retainage_pct, NULL)
    `).run({
      project_id,
      subcontractor_id,
      app_number,
      period_start,
      period_end,
      contract_sum: prior?.contract_sum ?? 0,
      change_orders: prior?.change_orders ?? 0,
      retainage_pct: prior?.retainage_pct ?? 10,
    });
    const newId = info.lastInsertRowid;

    if (prior) {
      // Copy lines from prior, rolling totals forward.
      const priorLines = db.prepare(`
        SELECT * FROM pay_app_lines WHERE pay_app_id = ?
        ORDER BY sort_order ASC, id ASC
      `).all(prior.id);
      const insertLine = db.prepare(`
        INSERT INTO pay_app_lines
          (pay_app_id, budget_line_id, description,
           scheduled_value, completed_previous,
           completed_this_period, stored_materials, sort_order)
        VALUES
          (@pay_app_id, @budget_line_id, @description,
           @scheduled_value, @completed_previous,
           0, 0, @sort_order)
      `);
      for (const l of priorLines) {
        const rolled = Number(l.completed_previous || 0)
          + Number(l.completed_this_period || 0)
          + Number(l.stored_materials || 0);
        insertLine.run({
          pay_app_id: newId,
          budget_line_id: l.budget_line_id,
          description: l.description,
          scheduled_value: l.scheduled_value,
          completed_previous: rolled,
          sort_order: l.sort_order ?? 0,
        });
      }
    } else {
      // First pay app for this combo: seed from project budget as a starter
      // Schedule of Values. User can edit/remove freely.
      const budgetLines = db.prepare(`
        SELECT * FROM budget_lines WHERE project_id = ?
        ORDER BY id ASC
      `).all(project_id);
      if (budgetLines.length > 0) {
        const insertLine = db.prepare(`
          INSERT INTO pay_app_lines
            (pay_app_id, budget_line_id, description,
             scheduled_value, completed_previous,
             completed_this_period, stored_materials, sort_order)
          VALUES
            (@pay_app_id, @budget_line_id, @description,
             @scheduled_value, 0, 0, 0, @sort_order)
        `);
        budgetLines.forEach((b, idx) => {
          insertLine.run({
            pay_app_id: newId,
            budget_line_id: b.id,
            description: b.description || b.category || b.cost_code || `Line ${idx + 1}`,
            scheduled_value: b.budgeted_amount || 0,
            sort_order: idx,
          });
        });
      }
    }

    return newId;
  })();

  const row = db.prepare('SELECT * FROM pay_applications WHERE id = ?').get(result);
  res.status(201).json({ ...withTotals(db, row), seeded_from: prior ? 'prior_pay_app' : 'project_budget' });
});

// PATCH /api/pay-apps/:id
router.patch('/:id', (req, res) => {
  const db = getDb();
  const updates = [];
  const values = {};
  for (const f of HEADER_FIELDS) {
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
    `UPDATE pay_applications SET ${updates.join(', ')} WHERE id = @id`
  ).run(values);
  if (result.changes === 0) return res.status(404).json({ error: 'Pay application not found' });
  const row = db.prepare('SELECT * FROM pay_applications WHERE id = ?').get(req.params.id);
  res.json(withTotals(db, row));
});

// DELETE /api/pay-apps/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM pay_applications WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Pay application not found' });
  res.json({ ok: true, deleted: Number(req.params.id) });
});

// GET /api/pay-apps/:id/pdf — stream an AIA G702/G703-style PDF.
// Query string ?download=1 forces an attachment download; otherwise opens inline.
router.get('/:id/pdf', (req, res) => {
  const db = getDb();
  const header = db.prepare(`
    SELECT
      pa.*,
      p.code AS project_code,
      p.name AS project_name,
      p.address AS project_address,
      s.name AS subcontractor_name,
      s.trade AS subcontractor_trade
    FROM pay_applications pa
    JOIN projects p ON p.id = pa.project_id
    LEFT JOIN subcontractors s ON s.id = pa.subcontractor_id
    WHERE pa.id = ?
  `).get(req.params.id);
  if (!header) return res.status(404).json({ error: 'Pay application not found' });

  const payApp = withTotals(db, header);
  const lines = db.prepare(`
    SELECT * FROM pay_app_lines WHERE pay_app_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(req.params.id);

  const project = {
    code: header.project_code,
    name: header.project_name,
    address: header.project_address,
  };
  const vendor = header.subcontractor_id
    ? { name: header.subcontractor_name, trade: header.subcontractor_trade }
    : null;

  const filename = [
    'PayApp',
    `${header.project_code}`,
    vendor ? vendor.name.replace(/[^a-zA-Z0-9]+/g, '_') : 'Owner',
    `${header.app_number}`,
  ].join('_') + '.pdf';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `${req.query.download ? 'attachment' : 'inline'}; filename="${filename}"`
  );

  renderPayAppPdf(res, {
    payApp,
    lines,
    project,
    vendor,
    issuerName: process.env.GC_NAME || 'Banyan Residential',
  });
});

// ============================================================
// PAY APP LINES (nested under pay-apps)
// ============================================================

// GET /api/pay-apps/:id/lines
router.get('/:id/lines', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM pay_app_lines WHERE pay_app_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(req.params.id);
  res.json(rows);
});

// POST /api/pay-apps/:id/lines — add a line
router.post('/:id/lines', (req, res) => {
  const db = getDb();
  const payApp = db.prepare('SELECT id FROM pay_applications WHERE id = ?').get(req.params.id);
  if (!payApp) return res.status(404).json({ error: 'Pay application not found' });

  const { description } = req.body;
  if (!description) {
    return res.status(400).json({ error: 'description is required' });
  }
  const info = db.prepare(`
    INSERT INTO pay_app_lines
      (pay_app_id, budget_line_id, description,
       scheduled_value, completed_previous, completed_this_period, stored_materials, sort_order)
    VALUES
      (@pay_app_id, @budget_line_id, @description,
       @scheduled_value, @completed_previous, @completed_this_period, @stored_materials, @sort_order)
  `).run({
    pay_app_id: req.params.id,
    budget_line_id: req.body.budget_line_id ?? null,
    description,
    scheduled_value: req.body.scheduled_value ?? 0,
    completed_previous: req.body.completed_previous ?? 0,
    completed_this_period: req.body.completed_this_period ?? 0,
    stored_materials: req.body.stored_materials ?? 0,
    sort_order: req.body.sort_order ?? 0,
  });
  const line = db.prepare('SELECT * FROM pay_app_lines WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(line);
});

module.exports = { router, LINE_FIELDS };
