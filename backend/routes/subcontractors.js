// Subcontractors / vendors CRUD
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

const SUB_FIELDS = [
  'name', 'trade', 'contact_name', 'email', 'phone',
  'address', 'license_number', 'tax_id',
  'insurance_expiry', 'status', 'notes'
];

// GET /api/subcontractors  — list, optional ?status=active|inactive, ?q=search
router.get('/', (req, res) => {
  const db = getDb();
  const where = [];
  const params = {};
  if (req.query.status) {
    where.push('status = @status');
    params.status = req.query.status;
  }
  if (req.query.q) {
    where.push('(name LIKE @q OR trade LIKE @q OR contact_name LIKE @q)');
    params.q = `%${req.query.q}%`;
  }
  const sql = `
    SELECT * FROM subcontractors
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY name COLLATE NOCASE ASC
  `;
  const rows = db.prepare(sql).all(params);
  res.json(rows);
});

// GET /api/subcontractors/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const sub = db.prepare('SELECT * FROM subcontractors WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subcontractor not found' });
  res.json(sub);
});

// POST /api/subcontractors  — create
router.post('/', (req, res) => {
  const db = getDb();
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const info = db.prepare(`
    INSERT INTO subcontractors
      (name, trade, contact_name, email, phone, address,
       license_number, tax_id, insurance_expiry, status, notes)
    VALUES
      (@name, @trade, @contact_name, @email, @phone, @address,
       @license_number, @tax_id, @insurance_expiry, COALESCE(@status, 'active'), @notes)
  `).run({
    name: name.trim(),
    trade: req.body.trade ?? null,
    contact_name: req.body.contact_name ?? null,
    email: req.body.email ?? null,
    phone: req.body.phone ?? null,
    address: req.body.address ?? null,
    license_number: req.body.license_number ?? null,
    tax_id: req.body.tax_id ?? null,
    insurance_expiry: req.body.insurance_expiry ?? null,
    status: req.body.status ?? null,
    notes: req.body.notes ?? null,
  });
  const sub = db.prepare('SELECT * FROM subcontractors WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(sub);
});

// PATCH /api/subcontractors/:id  — partial update
router.patch('/:id', (req, res) => {
  const db = getDb();
  const updates = [];
  const values = {};
  for (const f of SUB_FIELDS) {
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
    `UPDATE subcontractors SET ${updates.join(', ')} WHERE id = @id`
  ).run(values);
  if (result.changes === 0) return res.status(404).json({ error: 'Subcontractor not found' });
  const sub = db.prepare('SELECT * FROM subcontractors WHERE id = ?').get(req.params.id);
  res.json(sub);
});

// DELETE /api/subcontractors/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM subcontractors WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Subcontractor not found' });
  res.json({ ok: true, deleted: Number(req.params.id) });
});

module.exports = router;
