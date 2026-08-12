// =====================================================================
// Cost Report column math — pure functions, no DB.
// ---------------------------------------------------------------------
// Mirrors the "Summary" tab of the Turnkey Rail Budget Projection Report.
// Each row carries eight INPUT figures; the twelve derived columns are
// computed here using the exact formulas Irvin documented in the sheet's
// legend (rows 5-6). Keeping this separate from the DB layer lets us
// unit-test the math against the spreadsheet's tie-out numbers.
//
// Column map (letter = spreadsheet column, in report order):
//   D  original_budget        INPUT   Original Budget Amount
//   E  budget_modifications    INPUT   Budget Modifications      (Budget Mods tab)
//   F  approved_ocos           INPUT   Approved Owner COs
//   G  revised_budget          = D + E + F
//   H  committed_costs         INPUT   Committed Costs (subcontracts)
//   I  executed_cos            INPUT   Executed (approved) sub COs
//   J  pending_cos             INPUT   Pending sub COs
//   K  total_committed         = H + I + J
//   L  commitment_billings     INPUT   Commitment Billings (sub pay apps)
//   M  open_commitment         = K - L
//   N  direct_costs            INPUT   Direct Costs (CloudLedger)
//   O  total_job_cost          = L + N
//   P  projected_cost          = K + N   (Total Committed + Direct Costs)
//   Q  forecast_to_complete    = G - K - N
//   R  estimated_at_completion = P + Q
//   S  buyout_savings          = R - G
//   T  balance_to_fund         = G - O
//   U  pct_complete            = O / G   (0 when G = 0)
//
// NOTE on column P (Projected Cost): the spreadsheet's live cell formula is
// N+O (Direct Costs + Total Job Cost to Date), but the legend Irvin supplied
// defines it as Total Committed + Direct Costs (H+K in his letter scheme).
// The legend is the stated spec and the more sensible definition, so we use
// K + N here. Both produce the same result while there are no direct costs;
// they diverge once direct costs post. Flag for Irvin if he wants the literal
// cell formula instead.
// =====================================================================

const INPUT_KEYS = [
  'original_budget',
  'budget_modifications',
  'approved_ocos',
  'committed_costs',
  'executed_cos',
  'pending_cos',
  'commitment_billings',
  'direct_costs',
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Round to cents to avoid floating-point dust in totals.
function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}

// Given a row with the eight INPUT figures, return the row with all derived
// columns filled in. Extra fields on the input (cost_code, description, …)
// are preserved.
function computeRow(input) {
  const D = num(input.original_budget);
  const E = num(input.budget_modifications);
  const F = num(input.approved_ocos);
  const H = num(input.committed_costs);
  const I = num(input.executed_cos);
  const J = num(input.pending_cos);
  const L = num(input.commitment_billings);
  const N = num(input.direct_costs);

  const G = D + E + F;                 // revised_budget
  const K = H + I + J;                 // total_committed
  const M = K - L;                     // open_commitment
  const O = L + N;                     // total_job_cost
  const P = K + N;                     // projected_cost
  const Q = G - K - N;                 // forecast_to_complete
  const R = P + Q;                     // estimated_at_completion
  const S = R - G;                     // buyout_savings
  const T = G - O;                     // balance_to_fund
  const U = G !== 0 ? O / G : 0;       // pct_complete (fraction 0..1)

  return {
    ...input,
    original_budget: round2(D),
    budget_modifications: round2(E),
    approved_ocos: round2(F),
    revised_budget: round2(G),
    committed_costs: round2(H),
    executed_cos: round2(I),
    pending_cos: round2(J),
    total_committed: round2(K),
    commitment_billings: round2(L),
    open_commitment: round2(M),
    direct_costs: round2(N),
    total_job_cost: round2(O),
    projected_cost: round2(P),
    forecast_to_complete: round2(Q),
    estimated_at_completion: round2(R),
    buyout_savings: round2(S),
    balance_to_fund: round2(T),
    pct_complete: U,
  };
}

// Sum the eight INPUT figures across rows, then recompute the derived columns
// from those sums (so a subtotal/total obeys the same formulas as a line).
// `extra` lets callers stamp a label like { category: 'Total Project Costs' }.
function totalRow(rows, extra = {}) {
  const acc = {};
  for (const key of INPUT_KEYS) acc[key] = 0;
  for (const r of rows) {
    for (const key of INPUT_KEYS) acc[key] += num(r[key]);
  }
  return computeRow({ ...acc, ...extra });
}

module.exports = { INPUT_KEYS, num, round2, computeRow, totalRow };
