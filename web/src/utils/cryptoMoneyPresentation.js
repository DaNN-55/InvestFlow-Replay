// Display only: preserve the source value for calculations and hover details.
export function moneyAmount(value) {
  if(value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  if(number === 0) return '0.00';
  if(Math.abs(number) < 0.01) return number < 0 ? '-<0.01' : '<0.01';
  return number.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}
