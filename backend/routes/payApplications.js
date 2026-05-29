// Pay applications + line items
const express = require('express');
const cloudledger = require('../lib/cloudledger_client');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { getDb } = require('../db/database');
const { renderPayAppPdf } = require('../lib/payAppPdf');

// In-memory storage for the SoV import endpoint — we parse the spreadsheet
// once and discard the buffer, no need to persist the file to disk.
const sovUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB is plenty for SoV-sized sheets
});

const router = express.Router();

const HEADER_FIELDS = [
  'project_id', 'subcontractor_id', 'app_number',
  'period_start', 'period_end', 'submitted_date',
  'status', 'contract_sum', 'change_orders', 'retainage_pct', 'notes',
  'payment_method'
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

// Sum of approved change orders on a project. Optionally filter to a specific
// subcontractor — pass subcontractor_id=null to sum the project-wide totals
// (i.e. what Owner sees) including subs and project-direct change orders.
function sumApprovedChangeOrders(db, project_id, subcontractor_id) {
  if (subcontractor_id == null) {
    // Owner side: every approved CO on the project counts toward what the
    // owner ultimately owes us, regardless of which sub it ties to.
    const row = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM change_orders
      WHERE project_id = ? AND status = 'approved'
    `).get(project_id);
    return Number(row?.total || 0);
  }
  // Sub side: only COs tied to this sub (or project-level COs without a sub).
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM change_orders
    WHERE project_id = ?
      AND status = 'approved'
      AND (subcontractor_id = ? OR subcontractor_id IS NULL)
  `).get(project_id, subcontractor_id);
  return Number(row?.total || 0);
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

// POST /api/pay-apps/:id/cloudledger/resync
// Manually retry CloudLedger sync for this pay app's current status.
// Useful when sync failed previously (CL was down) or when integration was
// enabled after the pay app already moved past draft.
router.post('/:id/cloudledger/resync', async (req, res) => {
  const db = getDb();
  const pa = db.prepare('SELECT * FROM pay_applications WHERE id = ?').get(req.params.id);
  if (!pa) return res.status(404).json({ error: 'Pay application not found' });
  if (!cloudledger.isEnabled()) {
    return res.status(400).json({ error: 'CloudLedger integration not enabled' });
  }
  // Trick: call maybeSyncOnStatusChange with a synthetic "before" state that
  // forces all transitions up to current to fire. Since CL is idempotent,
  // already-synced events return their existing JE IDs without duplicating.
  const synthBefore = { ...pa, status: 'draft' };
  await maybeSyncOnStatusChange(db, synthBefore, pa);
  const updated = db.prepare('SELECT * FROM pay_applications WHERE id = ?').get(req.params.id);
  res.json({
    ok: true,
    status: updated.status,
    cloudledger_je_approved_id: updated.cloudledger_je_approved_id,
    cloudledger_je_paid_id: updated.cloudledger_je_paid_id,
  });
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
      // Auto-pull current approved change orders. Owner-side gets ALL approved
      // COs on the project; sub-side gets that sub's plus any project-level COs.
      // User can still override this on the PA detail page later.
      change_orders: sumApprovedChangeOrders(db, project_id, subcontractor_id),
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
//
// When status transitions to 'approved' or 'paid', also fire a CloudLedger
// sync (best-effort; failures are logged but do not block the update).
// The sync is idempotent on CL side, so retries are safe.
router.patch('/:id', async (req, res) => {
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

  // Snapshot prior state to detect status transitions
  const before = db.prepare('SELECT * FROM pay_applications WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Pay application not found' });

  updates.push(`updated_at = datetime('now')`);
  values.id = req.params.id;
  db.prepare(
    `UPDATE pay_applications SET ${updates.join(', ')} WHERE id = @id`
  ).run(values);
  const row = db.prepare('SELECT * FROM pay_applications WHERE id = ?').get(req.params.id);

  // Trigger CloudLedger sync on status transitions
  await maybeSyncOnStatusChange(db, before, row);

  res.json(withTotals(db, row));
});

// Fire CloudLedger sync events when pay app status transitions.
// Stores the resulting JE IDs back on the pay app row.
async function maybeSyncOnStatusChange(db, before, after) {
  if (!cloudledger.isEnabled()) return;
  if (before.status === after.status) return;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(after.project_id);
  if (!project) return;
  const isOwnerPayApp = after.subcontractor_id == null;
  const vendor = !isOwnerPayApp
    ? db.prepare('SELECT * FROM subcontractors WHERE id = ?').get(after.subcontractor_id)
    : null;

  // Compute the current period net billed amount (G703 totals minus retainage)
  const totalsRow = db.prepare(`
    SELECT COALESCE(SUM(completed_this_period + stored_materials), 0) AS gross
    FROM pay_app_lines WHERE pay_app_id = ?
  `).get(after.id);
  const grossThisPeriod = Number(totalsRow.gross || 0);
  const retainagePct = Number(after.retainage_pct || 0);
  const retainage = Math.round(grossThisPeriod * (retainagePct / 100) * 100) / 100;
  const netAmount = Math.round((grossThisPeriod - retainage) * 100) / 100;

  // Skip sync if there's no billable amount yet (e.g., approved before SoV lines
  // were added). The user can re-trigger sync later by toggling draft -> approved
  // after fixing the amount, but only if the prior log doesn't already have a
  // success record. For robustness, also tell CL to forget the previous sync if
  // we're re-approving with a different amount — TODO in a future iteration.
  if (netAmount < 0.005) {
    console.log('[cloudledger] pay app ' + after.id + ' status change skipped (zero amount)');
    return;
  }

  // Status: draft|submitted -> approved
  if (after.status === 'approved' && before.status !== 'approved') {
    const fn = isOwnerPayApp ? 'syncOwnerPayAppIssued' : 'syncSubPayAppApproved';
    const payload = {
      turnkey_project_id: project.id,
      payapp_id: after.id,
      vendor_name: vendor ? vendor.name : null,
      amount: netAmount,
      date: after.submitted_date || new Date().toISOString().slice(0, 10),
    };
    const r = await cloudledger.trySync('pay app ' + after.id + ' approved', () => cloudledger[fn](payload));
    if (r.ok && r.result && r.result.cl_entry_id) {
      db.prepare("UPDATE pay_applications SET cloudledger_je_approved_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(r.result.cl_entry_id, after.id);
    }
  }

  // Status: approved -> paid
  if (after.status === 'paid' && before.status !== 'paid') {
    const fn = isOwnerPayApp ? 'syncOwnerPaymentReceived' : 'syncSubPayAppPaid';
    const payload = {
      turnkey_project_id: project.id,
      payapp_id: after.id,
      vendor_name: vendor ? vendor.name : null,
      amount: netAmount,
      date: new Date().toISOString().slice(0, 10),
      payment_method: isOwnerPayApp ? undefined : (after.payment_method || 'wire'),
    };
    const r = await cloudledger.trySync('pay app ' + after.id + ' paid', () => cloudledger[fn](payload));
    if (r.ok && r.result && r.result.cl_entry_id) {
      db.prepare("UPDATE pay_applications SET cloudledger_je_paid_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(r.result.cl_entry_id, after.id);
    }
  }
}

// DELETE /api/pay-apps/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM pay_applications WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Pay application not found' });
  res.json({ ok: true, deleted: Number(req.params.id) });
});

// POST /api/pay-apps/:id/refresh-change-orders — re-pull approved CO total
// for an existing pay app. Useful when COs get approved AFTER the pay app
// was created and the user wants to update line 2 without re-typing.
router.post('/:id/refresh-change-orders', (req, res) => {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, project_id, subcontractor_id FROM pay_applications WHERE id = ?'
  ).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Pay application not found' });

  const newTotal = sumApprovedChangeOrders(db, existing.project_id, existing.subcontractor_id);
  db.prepare(
    `UPDATE pay_applications SET change_orders = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newTotal, existing.id);

  const row = db.prepare('SELECT * FROM pay_applications WHERE id = ?').get(existing.id);
  res.json(withTotals(db, row));
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

// ============================================================
// ALERTS — pay app variance / anomaly checks
// ============================================================
//
// The point: at month-end the user is reviewing a pay app and wants the system
// to flag anything unusual without having to eyeball every line. This endpoint
// is read-only and idempotent — it derives alerts on the fly from the current
// pay app + project state, so there's no separate "dismiss alert" workflow to
// build yet (would be a v2 feature with a small alerts table).
//
// Severity:
//   - error: the user should look before submitting/approving (over-budget, sub
//     billing beyond contract). Real money implications.
//   - warning: worth a glance but might be intentional (large jump from prior,
//     project-level margin negative).
//
// Each alert has { severity, code, message, line_id? }. Codes are stable so the
// UI can decide which to style differently later.
router.get('/:id/alerts', (req, res) => {
  const db = getDb();
  const header = db.prepare(`
    SELECT pa.*, p.code AS project_code, p.name AS project_name
    FROM pay_applications pa
    JOIN projects p ON p.id = pa.project_id
    WHERE pa.id = ?
  `).get(req.params.id);
  if (!header) return res.status(404).json({ error: 'Pay application not found' });

  const lines = db.prepare(`
    SELECT * FROM pay_app_lines WHERE pay_app_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(req.params.id);

  const alerts = [];

  // --- Line-level checks ---
  for (const l of lines) {
    const sched = Number(l.scheduled_value || 0);
    const prior = Number(l.completed_previous || 0);
    const thisPeriod = Number(l.completed_this_period || 0);
    const stored = Number(l.stored_materials || 0);
    const completed = prior + thisPeriod + stored;

    // Over-budget: completed > scheduled. Skip lines with sched=0 (those are
    // typically placeholder rows with no budget set yet).
    if (sched > 0 && completed > sched) {
      const overBy = completed - sched;
      alerts.push({
        severity: 'error',
        code: 'line_over_budget',
        message: `"${l.description}" is over its scheduled value by ${fmtForAlert(overBy)} (completed ${fmtForAlert(completed)} vs scheduled ${fmtForAlert(sched)}).`,
        line_id: l.id,
      });
    }

    // Big this-period jump: this_period > 50% of scheduled. This is the GC's
    // "are you sure?" check — a single month claiming half the line's budget
    // is unusual enough to warrant a glance.
    if (sched > 0 && thisPeriod > 0.5 * sched) {
      const pctOfSched = Math.round((thisPeriod / sched) * 100);
      alerts.push({
        severity: 'warning',
        code: 'line_big_jump',
        message: `"${l.description}" billed ${pctOfSched}% of the line's scheduled value in this period alone (${fmtForAlert(thisPeriod)} of ${fmtForAlert(sched)}). Verify the work was completed this period.`,
        line_id: l.id,
      });
    }
  }

  // --- Pay-app-level: sub side billing past revised contract ---
  // Only meaningful on the sub side. Owner side doesn't have the same
  // cap-against-contract semantics here (contract_sum on Owner pay apps is
  // typically 0 — owner billings get capped against project.revised_contract,
  // which we cover in the project-level check below).
  if (header.subcontractor_id != null) {
    // Cumulative earned-less-retainage for this sub on this project, summed
    // across every pay app (including this one) so we catch overbilling on the
    // PREVIOUS pay app surfacing this month.
    const subTotals = db.prepare(`
      SELECT
        COALESCE(SUM(
          (SELECT SUM(completed_previous + completed_this_period + stored_materials)
           FROM pay_app_lines WHERE pay_app_id = pa.id)
          * (1 - COALESCE(pa.retainage_pct, 0) / 100.0)
        ), 0) AS billed_cumulative
      FROM pay_applications pa
      WHERE pa.project_id = ? AND pa.subcontractor_id = ?
    `).get(header.project_id, header.subcontractor_id);
    const revised = Number(header.contract_sum || 0) + Number(header.change_orders || 0);
    const billed = Number(subTotals?.billed_cumulative || 0);
    if (revised > 0 && billed > revised) {
      const overBy = billed - revised;
      alerts.push({
        severity: 'error',
        code: 'sub_billed_over_contract',
        message: `Sub has billed ${fmtForAlert(billed)} cumulative on this project — ${fmtForAlert(overBy)} over the revised contract (${fmtForAlert(revised)}). Check for a missing approved change order.`,
      });
    }
  }

  // --- Project-level: cumulative margin negative ---
  // Mirrors the reconciliation endpoint's math. Owner billings minus sub
  // billings, both net of retainage. If subs are billing faster than owner is
  // being invoiced, that's a real cash-flow concern.
  const projectTotals = db.prepare(`
    SELECT
      pa.subcontractor_id IS NULL AS is_owner,
      COALESCE(SUM(
        (SELECT SUM(completed_previous + completed_this_period + stored_materials)
         FROM pay_app_lines WHERE pay_app_id = pa.id)
        * (1 - COALESCE(pa.retainage_pct, 0) / 100.0)
      ), 0) AS billed_cumulative
    FROM pay_applications pa
    WHERE pa.project_id = ?
    GROUP BY is_owner
  `).all(header.project_id);
  let ownerBilled = 0;
  let subBilled = 0;
  for (const row of projectTotals) {
    if (row.is_owner) ownerBilled = Number(row.billed_cumulative || 0);
    else subBilled = Number(row.billed_cumulative || 0);
  }
  if (subBilled > ownerBilled && subBilled > 0) {
    const gap = subBilled - ownerBilled;
    alerts.push({
      severity: 'warning',
      code: 'project_margin_negative',
      message: `Project has billed subs ${fmtForAlert(subBilled)} cumulative but only ${fmtForAlert(ownerBilled)} to the owner — gap of ${fmtForAlert(gap)}. Owner-side billing may be behind.`,
    });
  }

  res.json({
    pay_app_id: header.id,
    project_id: header.project_id,
    alerts,
    counts: {
      error: alerts.filter((a) => a.severity === 'error').length,
      warning: alerts.filter((a) => a.severity === 'warning').length,
    },
  });
});

// Tiny money formatter for alert messages. Server-side because alerts are
// rendered straight to the user without going through fmtMoney in the UI.
function fmtForAlert(n) {
  const v = Math.round(Number(n) || 0);
  return '$' + v.toLocaleString('en-US');
}

// ============================================================
// SOV EXCEL IMPORT / EXPORT
// ============================================================
//
// The Schedule of Values is the row-by-row backbone of every pay app. For a
// 100-line project, hand-entering it is painful. These two endpoints let the
// user round-trip the SoV through Excel:
//   - GET /:id/sov-template downloads an xlsx pre-filled with the current SoV
//     (or a blank skeleton if there are no lines yet).
//   - POST /:id/sov-import parses an uploaded xlsx and either replaces or
//     appends to the current SoV.
//
// Column contract (header row 1, lines start row 2):
//   A: Description
//   B: Scheduled Value
//   C: Prior (completed_previous)
//   D: This Period (completed_this_period)
//   E: Stored
//
// We intentionally do NOT round-trip Total / % / To finish — those are derived.

// GET /api/pay-apps/:id/sov-template
// Returns an xlsx with column headers + existing line items (if any).
router.get('/:id/sov-template', async (req, res) => {
  const db = getDb();
  const header = db.prepare(`
    SELECT pa.*, p.code AS project_code, p.name AS project_name
    FROM pay_applications pa
    JOIN projects p ON p.id = pa.project_id
    WHERE pa.id = ?
  `).get(req.params.id);
  if (!header) return res.status(404).json({ error: 'Pay application not found' });

  const lines = db.prepare(`
    SELECT * FROM pay_app_lines WHERE pay_app_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(req.params.id);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Turnkey Rail';
  wb.created = new Date();
  const ws = wb.addWorksheet('Schedule of Values', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'Description', key: 'description', width: 48 },
    { header: 'Scheduled Value', key: 'scheduled_value', width: 18, style: { numFmt: '$#,##0.00' } },
    { header: 'Prior', key: 'completed_previous', width: 14, style: { numFmt: '$#,##0.00' } },
    { header: 'This Period', key: 'completed_this_period', width: 14, style: { numFmt: '$#,##0.00' } },
    { header: 'Stored', key: 'stored_materials', width: 14, style: { numFmt: '$#,##0.00' } },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { horizontal: 'center' };
  ws.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE5E7EB' },
  };

  if (lines.length === 0) {
    // Empty template: give the user 10 blank rows to fill in.
    for (let i = 0; i < 10; i++) {
      ws.addRow({ description: '', scheduled_value: 0, completed_previous: 0, completed_this_period: 0, stored_materials: 0 });
    }
  } else {
    for (const l of lines) {
      ws.addRow({
        description: l.description,
        scheduled_value: Number(l.scheduled_value || 0),
        completed_previous: Number(l.completed_previous || 0),
        completed_this_period: Number(l.completed_this_period || 0),
        stored_materials: Number(l.stored_materials || 0),
      });
    }
  }

  const filename = `SoV_${header.project_code}_PayApp${header.app_number}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

// POST /api/pay-apps/:id/sov-import — multipart upload, field name "file".
// Query: ?mode=replace (default) | append
// On replace mode the existing pay_app_lines for this pay app are wiped first.
router.post('/:id/sov-import', sovUpload.single('file'), async (req, res) => {
  const db = getDb();
  const payApp = db.prepare('SELECT id FROM pay_applications WHERE id = ?').get(req.params.id);
  if (!payApp) return res.status(404).json({ error: 'Pay application not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const mode = req.query.mode === 'append' ? 'append' : 'replace';

  let parsed;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'Workbook contains no sheets' });
    parsed = parseSoVSheet(ws);
  } catch (e) {
    return res.status(400).json({ error: `Failed to parse spreadsheet: ${e.message}` });
  }

  if (parsed.errors.length > 0 && parsed.rows.length === 0) {
    return res.status(400).json({ error: 'No valid rows found', details: parsed.errors });
  }

  // Apply changes in a single transaction.
  const tx = db.transaction(() => {
    if (mode === 'replace') {
      db.prepare('DELETE FROM pay_app_lines WHERE pay_app_id = ?').run(payApp.id);
    }
    const baseSort = mode === 'append'
      ? (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM pay_app_lines WHERE pay_app_id = ?').get(payApp.id).next)
      : 0;
    const insert = db.prepare(`
      INSERT INTO pay_app_lines
        (pay_app_id, description,
         scheduled_value, completed_previous,
         completed_this_period, stored_materials, sort_order)
      VALUES
        (@pay_app_id, @description,
         @scheduled_value, @completed_previous,
         @completed_this_period, @stored_materials, @sort_order)
    `);
    parsed.rows.forEach((r, idx) => {
      insert.run({
        pay_app_id: payApp.id,
        description: r.description,
        scheduled_value: r.scheduled_value,
        completed_previous: r.completed_previous,
        completed_this_period: r.completed_this_period,
        stored_materials: r.stored_materials,
        sort_order: baseSort + idx,
      });
    });
  });
  tx();

  // Return the updated pay app so the UI can refresh in one round trip.
  const headerRow = db.prepare(`
    SELECT pa.*, p.code AS project_code, p.name AS project_name,
           s.name AS subcontractor_name, s.trade AS subcontractor_trade
    FROM pay_applications pa
    JOIN projects p ON p.id = pa.project_id
    LEFT JOIN subcontractors s ON s.id = pa.subcontractor_id
    WHERE pa.id = ?
  `).get(payApp.id);
  const lines = db.prepare(`
    SELECT * FROM pay_app_lines WHERE pay_app_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(payApp.id);

  res.json({
    imported: parsed.rows.length,
    skipped: parsed.errors.length,
    skip_reasons: parsed.errors,
    mode,
    pay_app: { ...withTotals(db, headerRow), lines },
  });
});

// Pull rows out of a worksheet. Tolerates:
//   - Any row order (we key by header cell text in row 1)
//   - Header capitalization / extra spaces
//   - Missing optional columns (Prior, This Period, Stored default to 0)
//   - Currency formatting ($ signs, commas) from Excel cells
function parseSoVSheet(ws) {
  // Build a column index map from header row (row 1). Accept reasonable
  // aliases so users can hand us a sheet that doesn't match our template
  // exactly.
  const aliases = {
    description: ['description', 'desc', 'item', 'line', 'work'],
    scheduled_value: ['scheduled value', 'scheduled', 'sov', 'value', 'amount', 'contract'],
    completed_previous: ['prior', 'completed previous', 'previous', 'prior period'],
    completed_this_period: ['this period', 'completed this period', 'this month', 'current'],
    stored_materials: ['stored', 'stored materials', 'materials stored'],
  };
  const headerCells = ws.getRow(1).values; // 1-indexed array
  const colMap = {};
  headerCells.forEach((v, idx) => {
    if (!v) return;
    const text = String(v).trim().toLowerCase();
    for (const [field, opts] of Object.entries(aliases)) {
      if (opts.includes(text)) {
        colMap[field] = idx;
        return;
      }
    }
  });
  if (colMap.description == null) {
    throw new Error('Missing required "Description" column in row 1');
  }
  if (colMap.scheduled_value == null) {
    throw new Error('Missing required "Scheduled Value" column in row 1');
  }

  const toNum = (cell) => {
    if (cell == null || cell === '') return 0;
    if (typeof cell === 'number') return cell;
    // Strip $, commas, whitespace.
    const cleaned = String(cell).replace(/[$,\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  };

  const rows = [];
  const errors = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const descCell = row.getCell(colMap.description).value;
    const description = descCell == null ? '' : String(descCell).trim();
    if (!description) continue; // Skip blank rows silently
    const scheduled_value = toNum(row.getCell(colMap.scheduled_value).value);
    if (scheduled_value < 0) {
      errors.push({ row: r, reason: 'Scheduled value cannot be negative' });
      continue;
    }
    rows.push({
      description,
      scheduled_value,
      completed_previous: colMap.completed_previous
        ? toNum(row.getCell(colMap.completed_previous).value) : 0,
      completed_this_period: colMap.completed_this_period
        ? toNum(row.getCell(colMap.completed_this_period).value) : 0,
      stored_materials: colMap.stored_materials
        ? toNum(row.getCell(colMap.stored_materials).value) : 0,
    });
  }
  return { rows, errors };
}

module.exports = { router, LINE_FIELDS };
