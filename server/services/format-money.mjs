/**
 * Formatare numerică română: 1234567.89 → "1.234.567,89"
 * Folosit în: PDF generation (formulare.mjs, nf-invest-pdf.mjs)
 */

export function formatMoneyRO(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '';
  // Accepts JS numbers or raw numeric strings from DB ('1234.56').
  // Does NOT accept Romanian-formatted strings ('1.234,56') — use parseMoneyRO first.
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(n)) return '';
  return n.toLocaleString('ro-RO', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function parseMoneyRO(str) {
  if (str === null || str === undefined || str === '') return null;
  const cleaned = String(str).trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}
