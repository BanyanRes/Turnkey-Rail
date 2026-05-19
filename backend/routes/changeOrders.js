// Change orders CRUD
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

const FIELDS = [
  'project_id', 'subcontractor_id', 'co_number',
  'description', 'reason', 'amount', 'days_added',
  'requested_date', 'approved_date', 'status', 'notes'
];

// GET /api/change-orders — list across all projects with joins
router.get('/', (req, res) => {
  const db = getDb();
  const where = [];
  const params = {};
  if (req.query.project_id) {
    where.push('co.project_id = @project_id');
    params.project_id = req.query.project_id;
  }
  if (req.query.subcontractor_id) {
    where.push('co.subcontractor_id = @subcontractor_id');
    params.subcontractor_id = req.query.subcontractor_id;
  }
  if (req.query.status) {
    where.push('co.status = @status');
    params.status = req.query.status;
  }
  if (req.query.scope === 'owner') {
    where.push('co.subcontractor_id IS NULL');
  } else if (req.query.scope === 'sub') {
    where.push('co.subcontractor_id IS NOT NULL');
  }
  const sql = `
    SELECT
      co.*,
      p.code AS project_code,
      p.name AS project_name,
      s.name AS subcontractor_name,
      s.trade AS subcontractor_trade
    FROM change_orders co
    JOIN projects p ON p.id = co.project_id
    LEFT JOIN subcontractors s ON s.id = co.subcontractor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY co.requested_date DESC, co.id DESC
  `;
  res.json(db.prepare(sql).all(params));
});

// GET /api/change-orders/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      co.*,
      p.code AS project_code,
      p.name AS project_name,
      s.name AS subcontractor_name,
      s.trade AS subcontractor_trade
    FROM change_orders co
    JOIN projects p ON p.id = co.project_id
    LEFT JOIN subcontractors s ON s.id = co.subcontractor_id
    WHERE co.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Change order not found' });
  res.json(row);
});

// POST /api/change-orders — create
router.post('/', (req, res) => {
  const db = getDb();
  const { project_id, description } = req.body;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }
  const subId = req.body.subcontractor_id ?? null;

  // Auto-number: next CO # for this project + vendor combo
  const last = db.prepare(`
    SELECT MAX(co_number) AS max_no FROM change_orders
    WHERE project_id = ?
      AND (subcontractor_id = ? OR (? IS NULL AND subcontractor_id IS NULL))
  `).get(project_id, subId, subId);
  const co_number = req.body.co_number ?? ((last?.max_no || 0) + 1);

  const info = db.prepare(`
    INSERT INTO change_orders
      (project_id, subcontractor_id, co_number,
       description, reason, amount, days_added,
       requested_date, approved_date, status, notes)
    VALUES
      (@project_id, @subcontractor_id, @co_number,
       @description, @reason, @amount, @days_added,
       @requested_date, @approved_date, COALESCE(@status, 'draft'), @notes)
  `).run({
    project_id,
    subcontractor_id: subId,
    co_number,
    description: description.trim(),
    reason: req.body.reason ?? null,
    amount: req.body.amount ?? 0,
    days_added: req.body.days_added ?? 0,
    requested_date: req.body.requested_date ?? null,
    approved_date: req.body.approved_date ?? null,
    status: req.body.status ?? null,
    notes: req.body.notes ?? null,
  });
  const row = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

// PATCH /api/change-orders/:id
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
  // Auto-stamp approved_date when status flips to 'approved' (only if not explicitly set)
  if (req.body.status === 'approved' && !('approved_date' in req.body)) {
    const existing = db.prepare('SELECT approved_date FROM change_orders WHERE id = ?').get(req.params.id);
    if (existing && !existing.approved_date) {
      updates.push(`approved_date = date('now')`);
    }
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }
  updates.push(`updated_at = datetime('now')`);
  values.id = req.params.id;
  const result = db.prepare(
    `UPDATE change_orders SET ${updates.join(', ')} WHERE id = @id`
  ).run(values);
  if (result.changes === 0) return res.status(404).json({ error: 'Change order not found' });
  const row = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(req.params.id);
  res.json(row);
});

// DELETE /api/change-orders/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM change_orders WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Change order not found' });
  res.json({ ok: true, deleted: Number(req.params.id) });
});

module.exports = router;
