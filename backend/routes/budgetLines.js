// Flat endpoints for single budget line edit/delete
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

const LINE_FIELDS = [
  'cost_code', 'category', 'description',
  'budgeted_amount', 'sort_order', 'notes'
];

// PATCH /api/budget-lines/:id  — partial update
router.patch('/:id', (req, res) => {
  const db = getDb();
  const updates = [];
  const values = {};
  for (const f of LINE_FIELDS) {
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
    `UPDATE budget_lines SET ${updates.join(', ')} WHERE id = @id`
  ).run(values);
  if (result.changes === 0) return res.status(404).json({ error: 'Budget line not found' });
  const line = db.prepare('SELECT * FROM budget_lines WHERE id = ?').get(req.params.id);
  res.json(line);
});

// DELETE /api/budget-lines/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM budget_lines WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Budget line not found' });
  res.json({ ok: true, deleted: Number(req.params.id) });
});

module.exports = router;
