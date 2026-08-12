// Projects + nested budget endpoints
const express = require('express');
const cloudledger = require('../lib/cloudledger_client');
const { computeRow, totalRow } = require('../lib/costReportCalc');
const { getDb } = require('../db/database');

const router = express.Router();

const PROJECT_FIELDS = [
  'code', 'name', 'address', 'owner_name', 'status',
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
          INSERT INTO projects (code, name, address, owner_name, status, contract_amount, start_date, end_date, notes)
          VALUES (@code, @name, @address, @owner_name, COALESCE(@status, 'active'), @contract_amount, @start_date, @end_date, @notes)
        `).run({
          code,
          name,
          address: req.body.address ?? null,
          owner_name: req.body.owner_name ?? null,
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

// =============================================================
// COST REPORT — the "Summary" tab, mirrored per project.
//
// GET /api/projects/:id/cost-report[?as_of=YYYY-MM-DD]
//
// Returns one row per budget line, grouped by category with subtotals and a
// grand total, carrying all 18 columns of the Turnkey Rail Budget Projection
// Report. Data sources per column:
//   Original Budget      budget_lines.budgeted_amount
//   Budget Modifications approved rows in budget_modifications (by cost code)
//   Approved OCOs        approved owner change orders (by cost code)
//   Committed Costs      latest sub pay app's scheduled values (by budget line)
//   Executed COs         approved sub change orders (by cost code)
//   Pending COs          draft/submitted sub change orders (by cost code)
//   Commitment Billings  latest sub pay app's completed-to-date (by budget line)
//   Direct Costs         CloudLedger GL, best-effort (by cost code)
// Everything else is derived (see lib/costReportCalc.js).
//
// Cost-code-keyed sources attach to the FIRST budget line carrying that code;
// amounts whose code matches no budget line (and sub pay-app lines with no
// linked budget line) collect on a single "Unallocated" row so the report
// always foots to the underlying data.
// =============================================================

const COST_REPORT_COLUMNS = [
  { key: 'original_budget',        label: 'Original Budget',        letter: 'A', computed: false },
  { key: 'budget_modifications',   label: 'Budget Modifications',   letter: 'B', computed: false },
  { key: 'approved_ocos',          label: 'Approved OCOs',          letter: 'C', computed: false },
  { key: 'revised_budget',         label: 'Revised Budget',         letter: 'D', computed: true },
  { key: 'committed_costs',        label: 'Committed Costs',        letter: 'E', computed: false },
  { key: 'executed_cos',           label: 'Executed Change Orders', letter: 'F', computed: false },
  { key: 'pending_cos',            label: 'Pending Change Orders',  letter: 'G', computed: false },
  { key: 'total_committed',        label: 'Total Committed',        letter: 'H', computed: true },
  { key: 'commitment_billings',    label: 'Commitment Billings',    letter: 'I', computed: false },
  { key: 'open_commitment',        label: 'Open Commitment Balance',letter: 'J', computed: true },
  { key: 'direct_costs',           label: 'Direct Costs',           letter: 'K', computed: false },
  { key: 'total_job_cost',         label: 'Total Job Cost to Date', letter: 'L', computed: true },
  { key: 'projected_cost',         label: 'Projected Cost',         letter: 'M', computed: true },
  { key: 'forecast_to_complete',   label: 'Forecast to Complete',   letter: 'N', computed: true },
  { key: 'estimated_at_completion',label: 'Estimated Cost at Completion', letter: 'O', computed: true },
  { key: 'buyout_savings',         label: 'Buyout Savings',         letter: 'P', computed: true },
  { key: 'balance_to_fund',        label: 'Balance to Fund',        letter: 'Q', computed: true },
  { key: 'pct_complete',           label: '% Complete to Costs',    letter: 'R', computed: true, percent: true },
];

router.get('/:id/cost-report', async (req, res) => {
  const db = getDb();
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);

  // --- Budget lines: the skeleton of the report ---
  const budgetLines = db.prepare(`
    SELECT id, cost_code, category, description, budgeted_amount, sort_order
    FROM budget_lines WHERE project_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(projectId);

  // --- Budget modifications (approved) by cost code ---
  const modRows = db.prepare(`
    SELECT cost_code, COALESCE(SUM(amount), 0) AS total
    FROM budget_modifications
    WHERE project_id = ? AND status = 'approved'
    GROUP BY cost_code
  `).all(projectId);
  const modsByCode = mapByCode(modRows);

  // --- Change orders by cost code, split by owner/sub and status ---
  const coRows = db.prepare(`
    SELECT
      cost_code,
      COALESCE(SUM(CASE WHEN subcontractor_id IS NULL AND status = 'approved' THEN amount ELSE 0 END), 0) AS approved_ocos,
      COALESCE(SUM(CASE WHEN subcontractor_id IS NOT NULL AND status = 'approved' THEN amount ELSE 0 END), 0) AS executed_cos,
      COALESCE(SUM(CASE WHEN subcontractor_id IS NOT NULL AND status IN ('draft','submitted') THEN amount ELSE 0 END), 0) AS pending_cos
    FROM change_orders
    WHERE project_id = ?
    GROUP BY cost_code
  `).all(projectId);
  const ocosByCode = new Map();
  const execByCode = new Map();
  const pendByCode = new Map();
  for (const r of coRows) {
    const code = normCode(r.cost_code);
    ocosByCode.set(code, Number(r.approved_ocos || 0));
    execByCode.set(code, Number(r.executed_cos || 0));
    pendByCode.set(code, Number(r.pending_cos || 0));
  }

  // --- Committed + Commitment Billings from each SUB's latest pay app ---
  // "Latest" = highest app_number for that sub on this project. Its schedule of
  // values is the committed subcontract by budget line; its completed-to-date
  // (prior + this period + stored) is the cumulative commitment billing.
  const commitRows = db.prepare(`
    SELECT
      pal.budget_line_id,
      COALESCE(SUM(pal.scheduled_value), 0) AS committed,
      COALESCE(SUM(pal.completed_previous + pal.completed_this_period + pal.stored_materials), 0) AS billed
    FROM pay_applications pa
    JOIN pay_app_lines pal ON pal.pay_app_id = pa.id
    WHERE pa.project_id = ?
      AND pa.subcontractor_id IS NOT NULL
      AND pa.app_number = (
        SELECT MAX(pa2.app_number) FROM pay_applications pa2
        WHERE pa2.project_id = pa.project_id AND pa2.subcontractor_id = pa.subcontractor_id
      )
    GROUP BY pal.budget_line_id
  `).all(projectId);
  const committedByLine = new Map();
  const billedByLine = new Map();
  let unallocCommitted = 0;
  let unallocBilled = 0;
  for (const r of commitRows) {
    if (r.budget_line_id == null) {
      unallocCommitted += Number(r.committed || 0);
      unallocBilled += Number(r.billed || 0);
    } else {
      committedByLine.set(r.budget_line_id, Number(r.committed || 0));
      billedByLine.set(r.budget_line_id, Number(r.billed || 0));
    }
  }

  // --- Direct costs from CloudLedger (best-effort) ---
  const directByCode = new Map();
  let directCostsAvailable = false;
  let directCostsNote = 'CloudLedger integration disabled';
  if (cloudledger.isEnabled()) {
    try {
      const cl = await cloudledger.getDirectCosts(projectId, asOf);
      const lines = (cl && Array.isArray(cl.lines)) ? cl.lines : [];
      for (const l of lines) {
        directByCode.set(normCode(l.cost_code), Number(l.amount || 0));
      }
      directCostsAvailable = true;
      directCostsNote = null;
    } catch (e) {
      directCostsNote = 'CloudLedger direct-costs unavailable: ' + e.message;
    }
  }

  // Track which cost-code-keyed amounts get consumed by a budget line, so the
  // leftovers can be swept into the Unallocated row.
  const consumedCode = { mods: new Set(), ocos: new Set(), exec: new Set(), pend: new Set(), direct: new Set() };
  const seenCode = new Set();

  const reportLines = budgetLines.map((b) => {
    const code = normCode(b.cost_code);
    const firstForCode = !seenCode.has(code);
    seenCode.add(code);
    // A cost-code-keyed source only lands on the FIRST budget line with that
    // code (avoids double-counting when several lines share a code).
    const take = (map, bucket) => {
      if (!firstForCode || !map.has(code)) return 0;
      consumedCode[bucket].add(code);
      return map.get(code);
    };
    return computeRow({
      budget_line_id: b.id,
      cost_code: b.cost_code,
      category: b.category || 'Uncategorized',
      description: b.description,
      original_budget: Number(b.budgeted_amount || 0),
      budget_modifications: take(modsByCode, 'mods'),
      approved_ocos: take(ocosByCode, 'ocos'),
      committed_costs: committedByLine.get(b.id) || 0,
      executed_cos: take(execByCode, 'exec'),
      pending_cos: take(pendByCode, 'pend'),
      commitment_billings: billedByLine.get(b.id) || 0,
      direct_costs: take(directByCode, 'direct'),
    });
  });

  // --- Unallocated row: anything keyed to a cost code with no budget line,
  // plus sub pay-app lines with no linked budget line. ---
  const leftover = (map, consumed) => {
    let sum = 0;
    for (const [code, val] of map.entries()) {
      if (!consumed.has(code)) sum += Number(val || 0);
    }
    return sum;
  };
  const unalloc = {
    budget_modifications: leftover(modsByCode, consumedCode.mods),
    approved_ocos: leftover(ocosByCode, consumedCode.ocos),
    executed_cos: leftover(execByCode, consumedCode.exec),
    pending_cos: leftover(pendByCode, consumedCode.pend),
    direct_costs: leftover(directByCode, consumedCode.direct),
    committed_costs: unallocCommitted,
    commitment_billings: unallocBilled,
  };
  const hasUnalloc = Object.values(unalloc).some((v) => Math.abs(Number(v || 0)) > 0.005);
  if (hasUnalloc) {
    reportLines.push(computeRow({
      budget_line_id: null,
      cost_code: '—',
      category: 'Unallocated',
      description: 'Unallocated (no matching budget line)',
      original_budget: 0,
      ...unalloc,
    }));
  }

  // --- Group into categories in first-seen order, with subtotals ---
  const order = [];
  const byCat = new Map();
  for (const row of reportLines) {
    const cat = row.category || 'Uncategorized';
    if (!byCat.has(cat)) { byCat.set(cat, []); order.push(cat); }
    byCat.get(cat).push(row);
  }
  const categories = order.map((cat) => {
    const rows = byCat.get(cat);
    return { category: cat, rows, subtotal: totalRow(rows, { category: cat, description: 'Total ' + cat }) };
  });
  const grand_total = totalRow(reportLines, { category: null, description: 'Total Project Costs' });

  res.json({
    project: {
      id: project.id, code: project.code, name: project.name,
      owner_name: project.owner_name || null, status: project.status,
      contract_amount: Number(project.contract_amount || 0),
    },
    as_of: asOf,
    columns: COST_REPORT_COLUMNS,
    categories,
    grand_total,
    direct_costs: { available: directCostsAvailable, note: directCostsNote },
  });
});

// Normalize a cost code for map keys (null/blank -> a stable sentinel).
function normCode(code) {
  const c = (code == null ? '' : String(code)).trim();
  return c === '' ? ' nocode' : c;
}
function mapByCode(rows) {
  const m = new Map();
  for (const r of rows) m.set(normCode(r.cost_code), Number(r.total || 0));
  return m;
}

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
