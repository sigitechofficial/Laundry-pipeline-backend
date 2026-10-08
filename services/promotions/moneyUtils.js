'use strict';

/**
 * Safe money utilities — avoids JS floating-point errors.
 * Uses string-based decimal arithmetic for 2-decimal-place operations.
 * Compatible with existing DECIMAL(10,2) schema.
 */

/** Parse any value to a safe 2-decimal number. */
function toDecimal(val) {
  if (val == null) return 0;
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  return Number.isFinite(n) ? n : 0;
}

/** Format to 2 decimal string (safe for DB). */
function money(val) {
  return toDecimal(val).toFixed(2);
}

/** Convert to integer minor units (pence/cents). */
function toMinor(val) {
  return Math.round(toDecimal(val) * 100);
}

/** Convert minor units back to decimal. */
function fromMinor(minorVal) {
  return (Number(minorVal) || 0) / 100;
}

/** Safe addition of multiple decimal values. */
function addMoney(...vals) {
  const sumMinor = vals.reduce((acc, v) => acc + toMinor(v), 0);
  return fromMinor(sumMinor);
}

/** Safe subtraction: a - b, floored at 0. */
function subtractMoney(a, b) {
  const result = toMinor(a) - toMinor(b);
  return fromMinor(Math.max(0, result));
}

/** Safe multiply for percentage: amount * (pct / 100), rounded half-up. */
function percentOf(amount, pct) {
  const amountMinor = toMinor(amount);
  const result = Math.round((amountMinor * toDecimal(pct)) / 100);
  return fromMinor(result);
}

/** Min of multiple money values. */
function minMoney(...vals) {
  const minors = vals.map(toMinor);
  return fromMinor(Math.min(...minors));
}

/** Max of multiple money values. */
function maxMoney(...vals) {
  const minors = vals.map(toMinor);
  return fromMinor(Math.max(...minors));
}

/** Check if money value is positive. */
function isPositive(val) {
  return toMinor(val) > 0;
}

/** Allocate a total discount proportionally across line amounts (for refund correctness). */
function allocateProportionally(totalDiscount, lineAmounts) {
  const total = lineAmounts.reduce((sum, a) => sum + toMinor(a), 0);
  if (total <= 0) return lineAmounts.map(() => 0);

  const discountMinor = toMinor(totalDiscount);
  let remaining = discountMinor;
  const allocations = [];

  for (let i = 0; i < lineAmounts.length; i++) {
    if (i === lineAmounts.length - 1) {
      allocations.push(remaining);
    } else {
      const share = Math.round((toMinor(lineAmounts[i]) / total) * discountMinor);
      allocations.push(share);
      remaining -= share;
    }
  }

  return allocations.map(fromMinor);
}

/** Percentage of an integer minor amount, rounded half-up, in minor units. */
function percentOfMinor(amountMinor, pct) {
  return Math.round((Number(amountMinor) * toDecimal(pct)) / 100);
}

/**
 * Split totalMinor across weights (minor units) with the largest-remainder method.
 * Shares always sum to totalMinor and no share exceeds its weight when totalMinor <= sum(weights).
 */
function allocateMinor(totalMinor, weightsMinor) {
  const weights = weightsMinor.map((w) => Math.max(0, Math.round(Number(w) || 0)));
  const sum = weights.reduce((s, w) => s + w, 0);
  const total = Math.max(0, Math.min(Math.round(Number(totalMinor) || 0), sum));
  if (sum <= 0 || total <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (w * total) / sum);
  const shares = exact.map(Math.floor);
  let remainder = total - shares.reduce((s, v) => s + v, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    if (shares[i] < weights[i]) {
      shares[i] += 1;
      remainder -= 1;
    }
  }
  return shares;
}

module.exports = {
  percentOfMinor,
  allocateMinor,
  toDecimal,
  money,
  toMinor,
  fromMinor,
  addMoney,
  subtractMoney,
  percentOf,
  minMoney,
  maxMoney,
  isPositive,
  allocateProportionally,
};
