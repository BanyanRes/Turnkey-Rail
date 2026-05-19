// Pay applications + line items
const express = require('express');
const { getDb } = require('../db/database');

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
