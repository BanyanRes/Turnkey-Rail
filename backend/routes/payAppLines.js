// Flat endpoints for single pay-app line edit/delete
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

const LINE_FIELDS = [
  'budget_line_id', 'description',
  'scheduled_value', 'completed_previous',
  'completed_this_period', 'stored_materials', 'sort_order'
];

// Given a line + a desired total completion percentage (0-100), figure out
// what completed_this_period should be set to so that
//   (completed_previous + completed_this_period + stored_materials) / scheduled_value
// equals pct/100. completed_this_period is clamped >= 0 (we don't let a %
// reduction go negative — for that the user should edit the raw column).
function thisPeriodForPct(line, pct) {
  const sched = Number(line.scheduled_value || 0);
  if (sched <= 0) return 0;
  const target = sched * (pct / 100);
  const fixed = Number(line.completed_previous || 0) + Number(line.stored_materials || 0);
  return Math.max(0, target - fixed);
}

// PATCH /api/pay-app-lines/:id
//
// Standard fields update directly. As a convenience, the body may include
// `pct_complete` (0-100) instead of completed_this_period; the server then
// computes the matching completed_this_period for the current line state.
router.patch('/:id', (req, res) => {
  const db = getDb();
  const body = { ...req.body };

  // Translate pct_complete into completed_this_period BEFORE building UPDATE.
  if ('pct_complete' in body) {
    const existing = db.prepare('SELECT * FROM pay_app_lines WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Line not found' });
    const pct = Number(body.pct_complete);
    if (Number.isNaN(pct) || pct < 0 || pct > 999) {
      return res.status(400).json({ error: 'pct_complete must be a number 0-999' });
    }
    body.completed_this_period = thisPeriodForPct(existing, pct);
    delete body.pct_complete;
  }

  const updates = [];
  const values = {};
  for (const f of LINE_FIELDS) {
    if (f in body) {
      updates.push(`${f} = @${f}`);
      values[f] = body[f];
    }
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }
  updates.push(`updated_at = datetime('now')`);
  values.id = req.params.id;
  const result = db.prepare(
    `UPDATE pay_app_lines SET ${updates.join(', ')} WHERE id = @id`
  ).run(values);
  if (result.changes === 0) return res.status(404).json({ error: 'Line not found' });
  const line = db.prepare('SELECT * FROM pay_app_lines WHERE id = ?').get(req.params.id);
  res.json(line);
});

// DELETE /api/pay-app-lines/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM pay_app_lines WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Line not found' });
  res.json({ ok: true, deleted: Number(req.params.id) });
});

module.exports = router;

