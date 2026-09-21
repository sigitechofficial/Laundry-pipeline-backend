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

console.log('adminPayoutLedger tests passed');
