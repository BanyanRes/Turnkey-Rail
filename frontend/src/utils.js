export function fmtMoney(n, { dash = true } = {}) {
  if (n == null || n === '') return dash ? '—' : '';
  const num = Number(n);
  if (Number.isNaN(num)) return dash ? '—' : '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(num);
}

export function parseMoney(s) {
  if (s == null) return 0;
  const cleaned = String(s).replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}
