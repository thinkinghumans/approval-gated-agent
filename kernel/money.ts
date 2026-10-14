export function roundCents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function hasAtMostTwoDecimals(n: number): boolean {
  return Math.abs(roundCents(n) - n) < 1e-9;
}
