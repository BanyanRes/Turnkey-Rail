// Lien waivers CRUD
//
// Tracks conditional/unconditional progress and final waivers in BOTH directions:
//   inbound  — subs → us (GC)
//   outbound — us → owner
//
// CA Civil Code §8132–8138 style.
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

const VALID_DIRECTIONS = ['inbound', 'outbound'];
const VALID_TYPES = [
  'conditional_progress',
  'unconditional_progress',
  'conditional_final',
  'unconditional_final',
];

const FIELDS = [
  'direction', 'project_id', 'subcontractor_id', 'pay_app_id',
  'waiver_type', 'amount', 'through_date', 'signed_date',
  'period_start', 'period_end',
  'document_id', 'notes',
];

// GET /api/lien-waivers — list with vendor / project / pay-app / document joins.
// Filters: direction, project_id, subcontractor_id, pay_app_id, waiver_type
router.get('/', (req, res) => {
  const db = getDb();
  const where = [];
  const params = {};

  if (req.query.direction) {
    where.push('lw.direction = @direction');
    params.direction = req.query.direction;
  }
  if (req.query.project_id) {
    where.push('lw.project_id = @project_id');
    params.project_id = req.query.project_id;
  }
  if (req.query.subcontractor_id) {
    where.push('lw.subcontractor_id = @subcontractor_id');
    params.subcontractor_id = req.query.subcontractor_id;
  }
  if (req.query.pay_app_id) {
    where.push('lw.pay_app_id = @pay_app_id');
    params.pay_app_id = req.query.pay_app_id;
  }
  if (req.query.waiver_type) {
    where.push('lw.waiver_type = @waiver_type');
    params.waiver_type = req.query.waiver_type;
  }

  const sql = `
    SELECT
      lw.*,
      p.code  AS project_code,
      p.name  AS project_name,
      s.name  AS subcontractor_name,
      s.trade AS subcontractor_trade,
      pa.app_number AS pay_app_number,
      d.filename AS document_filename,
      d.stored_path AS document_stored_path
    FROM lien_waivers lw
    LEFT JOIN projects        p  ON p.id  = lw.project_id
    LEFT JOIN subcontractors  s  ON s.id  = lw.subcontractor_id
    LEFT JOIN pay_applications pa ON pa.id = lw.pay_app_id
    LEFT JOIN documents       d  ON d.id  = lw.document_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY lw.signed_date DESC, lw.created_at DESC
  `;
  const rows = db.prepare(sql).all(params);
  res.json(rows);
});

// GET /api/lien-waivers/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      lw.*,
      p.code  AS project_code,
      p.name  AS project_name,
      s.name  AS subcontractor_name,
      s.trade AS subcontractor_trade,
      pa.app_number AS pay_app_number,
      d.filename AS document_filename
    FROM lien_waivers lw
    LEFT JOIN projects        p  ON p.id  = lw.project_id
    LEFT JOIN subcontractors  s  ON s.id  = lw.subcontractor_id
    LEFT JOIN pay_applications pa ON pa.id = lw.pay_app_id
    LEFT JOIN documents       d  ON d.id  = lw.document_id
    WHERE lw.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// POST /api/lien-waivers
router.post('/', (req, res) => {
  const db = getDb();
  const body = req.body || {};

  const direction = body.direction || 'inbound';
  if (!VALID_DIRECTIONS.includes(direction)) {
    return res.status(400).json({ error: `direction must be one of: ${VALID_DIRECTIONS.join(', ')}` });
  }
  if (!body.project_id) return res.status(400).json({ error: 'project_id required' });
  if (!body.waiver_type) return res.status(400).json({ error: 'waiver_type required' });
  if (!VALID_TYPES.includes(body.waiver_type)) {
    return res.status(400).json({ error: `waiver_type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  // Inbound waivers must identify the signing sub. Outbound waivers come FROM
  // us, so subcontractor_id stays null.
  if (direction === 'inbound' && !body.subcontractor_id) {
    return res.status(400).json({ error: 'subcontractor_id required for inbound waivers' });
  }

  const payload = {
    direction,
    project_id: body.project_id,
    subcontractor_id: direction === 'outbound' ? null : (body.subcontractor_id || null),
    pay_app_id: body.pay_app_id || null,
    waiver_type: body.waiver_type,
    amount: Number(body.amount) || 0,
    through_date: body.through_date || null,
    signed_date: body.signed_date || null,
    period_start: body.period_start || null,
    period_end: body.period_end || null,
    document_id: body.document_id || null,
    notes: body.notes || null,
  };

  const cols = Object.keys(payload).join(', ');
  const placeholders = Object.keys(payload).map((k) => '@' + k).join(', ');
  const result = db.prepare(
    `INSERT INTO lien_waivers (${cols}) VALUES (${placeholders})`
  ).run(payload);

  const row = db.prepare('SELECT * FROM lien_waivers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// PATCH /api/lien-waivers/:id
router.patch('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM lien_waivers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  if (body.direction && !VALID_DIRECTIONS.includes(body.direction)) {
    return res.status(400).json({ error: `direction must be one of: ${VALID_DIRECTIONS.join(', ')}` });
  }
  if (body.waiver_type && !VALID_TYPES.includes(body.waiver_type)) {
    return res.status(400).json({ error: `waiver_type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  const updates = [];
  const params = { id: req.params.id };
  for (const f of FIELDS) {
    if (f in body) {
      updates.push(`${f} = @${f}`);
      params[f] = body[f];
    }
  }
  if (updates.length === 0) {
    return res.json(existing);
  }
  updates.push("updated_at = datetime('now')");
  db.prepare(`UPDATE lien_waivers SET ${updates.join(', ')} WHERE id = @id`).run(params);
  const row = db.prepare('SELECT * FROM lien_waivers WHERE id = ?').get(req.params.id);
  res.json(row);
});

// DELETE /api/lien-waivers/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM lien_waivers WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
