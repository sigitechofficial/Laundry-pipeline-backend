'use strict';

const assert = require('assert');
const {
  AGENT_PAYOUT_REFERENCE,
  WITHDRAWAL_REFERENCE,
  buildAdminConnectPayoutLedger,
  isAgentWithdrawalRequestDescription,
  ADMIN_PAYOUT_PROCESSING_PREFIX,
} = require('./adminPayoutLedger');

const pair = buildAdminConnectPayoutLedger({
  userId: 12,
  amount: 25.5,
  currency: 'GBP',
  note: 'Weekly',
  adminUserId: 7,
  stripeTransferId: 'tr_test_1',
});

assert.strictEqual(pair.credit.referenceType, AGENT_PAYOUT_REFERENCE);
assert.strictEqual(pair.debit.referenceType, WITHDRAWAL_REFERENCE);
assert.strictEqual(pair.credit.type, 'credit');
assert.strictEqual(pair.debit.type, 'debit');
assert.strictEqual(pair.credit.status, 'completed');
assert.strictEqual(pair.debit.status, 'completed');
assert.strictEqual(pair.credit.amount, 25.5);
assert.strictEqual(pair.debit.amount, 25.5);
assert.strictEqual(pair.credit.stripeTransferId, 'tr_test_1');
// Regression: wallets.stripeTransferId is UNIQUE. If the paired debit carried
// the same id, the completion transaction in recordAgentPayout would roll back
// AFTER the Stripe transfer already succeeded (money sent, no ledger record).
assert.strictEqual(pair.debit.stripeTransferId, null);
assert.ok(pair.debit.description.startsWith(ADMIN_PAYOUT_PROCESSING_PREFIX));

assert.strictEqual(
  isAgentWithdrawalRequestDescription('Withdrawal request (pending admin approval)'),
  true
);
assert.strictEqual(
  isAgentWithdrawalRequestDescription(pair.debit.description),
  false
);

// Both rows are in the shop's currency, passed by the caller (no GBP default).
assert.strictEqual(pair.credit.currency, 'GBP');
assert.strictEqual(pair.debit.currency, 'GBP');
const eurPair = buildAdminConnectPayoutLedger({ userId: 12, amount: 5, currency: 'eur', note: null, adminUserId: null });
assert.strictEqual(eurPair.credit.currency, 'EUR');
assert.strictEqual(eurPair.debit.currency, 'EUR');
assert.throws(
  () => buildAdminConnectPayoutLedger({ userId: 12, amount: 5, note: null, adminUserId: null }),
  /buildAdminConnectPayoutLedger: currency code is required/
);

console.log('adminPayoutLedger tests passed');
