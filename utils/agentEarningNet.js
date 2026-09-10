"use strict";

/**
 * Net agent commission after customer refunds.
 * Wallet credits are preferred once posted; clawbacks always subtract.
 * Full refund → £0 even if billing still holds the original invoice share.
 */
function money(value) {
  const n = Number(value);
  return parseFloat((Number.isFinite(n) ? n : 0).toFixed(2));
}

function netAgentEarning({ billed = 0, credited = 0, clawed = 0 } = {}) {
  const billedAmt = money(billed);
  const creditedAmt = money(credited);
  const clawedAmt = money(clawed);
  const gross = creditedAmt > 0.009 ? creditedAmt : billedAmt;
  return money(Math.max(0, gross - clawedAmt));
}

module.exports = {
  money,
  netAgentEarning,
};
