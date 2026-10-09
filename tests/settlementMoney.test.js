'use strict';

/**
 * Cash settlement safety (local DB): refunds per refund, one money action per shop
 * at a time, retry dedupe, review audit, zone scope, report date ranges.
 * Uses shop owner 44 (shop address 16, zone 3) and one of its bookings that has no
 * wallet rows; every row it writes is deleted at the end.
 *
 *   NODE_ENV=development node tests/settlementMoney.test.js
 */

const assert = require('assert');
const { Op } = require('sequelize');
const models = require('../models');
const walletService = require('../services/Agent/agentWalletService');
const settlement = require('../services/Agent/agentSettlementService');
const { resolveAgentReportRange } = require('../utils/agentReportRange');

const { sequelize, wallet } = models;
const OWNER = 44;
const SHOP_ADDRESS = 16;
const SHOP_ZONE = 3;

const results = [];
function check(name, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

async function main() {
  const existing = await wallet.count({ where: { userId: OWNER } });
  if (existing) throw new Error(`owner ${OWNER} already has ${existing} wallet rows — run on a clean local DB`);
  const [[free]] = await sequelize.query(
    `SELECT b.id FROM bookings b LEFT JOIN wallets w ON w.bookingId = b.id
     WHERE w.id IS NULL AND b.laundryShopId = :shop ORDER BY b.id DESC LIMIT 1`,
    { replacements: { shop: SHOP_ADDRESS } }
  );
  const B = free.id;

  // Cash order: £100 collected by the shop, £40 commission.
  await wallet.create({ userId: OWNER, bookingId: B, referenceType: 'cash_collected', amount: 100, type: 'debit', status: 'completed', currency: 'GBP', description: 'test cash collected' });
  await wallet.create({ userId: OWNER, bookingId: B, referenceType: 'booking_commission', amount: 40, type: 'credit', status: 'completed', currency: 'GBP', description: 'test commission' });
  let s = await walletService.getWalletSummary(OWNER);
  check('setup: shop owes £60 cash', s.cashDueToPlatform === 60, `due=${s.cashDueToPlatform}`);

  // ── Refunds: one ledger row per refund (was a duplicate-key 500 on the 2nd refund) ──
  const c1 = await walletService.clawbackCommissionForRefund({ bookingId: B, agentUserId: OWNER, amount: 10, refundId: 'T1', orderLabel: 'T' });
  const c2 = await settle(walletService.clawbackCommissionForRefund({ bookingId: B, agentUserId: OWNER, amount: 10, refundId: 'T2', orderLabel: 'T' }));
  check('second partial refund on the same order records its own clawback', c1.recorded && c2.ok && c2.v.recorded, c2.ok ? '' : c2.e.message);
  const c1again = await walletService.clawbackCommissionForRefund({ bookingId: B, agentUserId: OWNER, amount: 10, refundId: 'T1', orderLabel: 'T' });
  check('the same refund twice is still recorded once', c1again.reason === 'already_recorded');
  const r2 = await settle(walletService.reverseCashCollectedForRefund({ bookingId: B, agentUserId: OWNER, amount: 5, refundId: 'T2', orderLabel: 'T' }));
  const r3 = await settle(walletService.reverseCashCollectedForRefund({ bookingId: B, agentUserId: OWNER, amount: 5, refundId: 'T3', orderLabel: 'T' }));
  check('two cash refunds on one order both recorded', r2.ok && r3.ok && r2.v.recorded && r3.v.recorded);
  const dupCommission = await settle(wallet.create({ userId: OWNER, bookingId: B, referenceType: 'booking_commission', amount: 40, type: 'credit', status: 'completed', currency: 'GBP', description: 'dup' }));
  check('commission is still one per order (unique key kept)', !dupCommission.ok);
  s = await walletService.getWalletSummary(OWNER);
  // balance = 40 − 20 (clawbacks) + 10 (cash refunded) − 100 = −70
  check('cash due after refunds = £70', s.cashDueToPlatform === 70, `due=${s.cashDueToPlatform}`);

  // ── Agent remittance: concurrency + retry ──
  const [a, b] = await Promise.all([
    settle(settlement.submitCashRemittance(OWNER, { amount: 50, note: 'first' })),
    settle(settlement.submitCashRemittance(OWNER, { amount: 45, note: 'second' })),
  ]);
  check('two remittances at once cannot exceed the cash due (one refused)', [a, b].filter((x) => x.ok).length === 1,
    [a, b].map((x) => (x.ok ? `ok ${x.v.amount}` : x.e.message)).join(' | '));
  const winner = a.ok ? a.v : b.v;
  const retry = await settlement.submitCashRemittance(OWNER, { amount: winner.amount, note: 'retry' });
  check('an app retry of the same amount returns the first remittance', retry.duplicate === true && retry.remittanceId === winner.remittanceId);
  s = await walletService.getWalletSummary(OWNER);
  check('only one pending remittance exists', s.pendingCashRemittance === winner.amount, `pending=${s.pendingCashRemittance}`);

  // ── Admin "record cash": concurrency ──
  const room = Number((s.cashDueToPlatform - s.pendingCashRemittance).toFixed(2)); // 20 or 25
  const [x, y] = await Promise.all([
    settle(settlement.adminRecordCashSettlement(OWNER, { amount: room - 2, note: 'till', adminUserId: 1 })),
    settle(settlement.adminRecordCashSettlement(OWNER, { amount: room - 3, note: 'till 2', adminUserId: 1 })),
  ]);
  check('two admins recording cash at once cannot over-collect', [x, y].filter((r) => r.ok).length === 1,
    [x, y].map((r) => (r.ok ? 'ok' : r.e.message)).join(' | '));
  const rec = (x.ok ? x : y).v;
  const recRow = await wallet.findByPk(rec.settlementId);
  check('recorded cash keeps who recorded it', recRow.reviewedByAdminId === 1 && recRow.adminNote);
  const left = Number((room - (x.ok ? room - 2 : room - 3)).toFixed(2));
  const pendingOnly = await settle(settlement.adminRecordCashSettlement(OWNER, { amount: left + 0.5, adminUserId: 1 }));
  check('over-recording is refused', !pendingOnly.ok, pendingOnly.ok ? '' : pendingOnly.e.message);

  // ── Review audit ──
  const conf = await settlement.confirmCashRemittance(winner.remittanceId, 'counted', 1);
  const row = await wallet.findByPk(winner.remittanceId);
  check('confirm stores admin, time and note', conf.status === 'completed' && row.reviewedByAdminId === 1 && row.reviewedAt && row.adminNote === 'counted');
  const again = await settle(settlement.confirmCashRemittance(winner.remittanceId, 'again', 1));
  check('a remittance cannot be reviewed twice', !again.ok);
  const list = await settlement.listAgentRemittances(OWNER, { limit: 5 });
  const mine = list.remittances.find((r) => r.id === winner.remittanceId);
  check('agent list returns the agent note and the admin note separately', mine.note === (a.ok ? 'first' : 'second') && mine.adminNote === 'counted', JSON.stringify({ note: mine.note, adminNote: mine.adminNote }));

  // ── Adjustment needs a reason ──
  const noReason = await settle(settlement.adminRecordAdjustment(OWNER, { amount: 1, direction: 'credit', adminUserId: 1 }));
  check('adjustment without a reason is refused', !noReason.ok && /reason/i.test(noReason.e.message));

  // ── Zone scope ──
  const inZone = await settle(settlement.assertAgentInZone(OWNER, SHOP_ZONE));
  const otherZone = await settle(settlement.assertAgentInZone(OWNER, 1));
  const allZones = await settle(settlement.assertAgentInZone(OWNER, null));
  check('zone manager: own-zone shop allowed, other zone → not found, platform admin → all', inZone.ok && !otherZone.ok && allZones.ok);
  const zoneList = await settlement.listPendingRemittances({ zoneId: 1 });
  check('pending remittances list is limited to the zone', zoneList.remittances.every((r) => r.agentUserId !== OWNER));

  // ── Agent ledger ──
  const oldView = await walletService.getWalletTransactions(OWNER, {});
  const fullView = await walletService.getWalletTransactions(OWNER, { scope: 'all', limit: 50 });
  check('transactions: default view unchanged (payouts/withdrawals only), scope=all shows the settlement ledger',
    oldView.transactions.length === 0 && fullView.transactions.length >= 7, `default=${oldView.transactions.length} all=${fullView.transactions.length}`);

  // ── Report ranges ──
  const now = new Date(2026, 9, 9, 15, 0, 0);
  const custom = resolveAgentReportRange('custom', { startDate: '2026-09-01', endDate: '2026-09-07' }, now);
  check('custom range covers both whole days', custom.start.getDate() === 1 && custom.end.getDate() === 7 && custom.end.getHours() === 23);
  const week = resolveAgentReportRange('week', {}, now);
  check('week starts on Monday', week.start.getDay() === 1 && week.start.getDate() === 5);
  assert.throws(() => resolveAgentReportRange('custom', { startDate: '2026-09-07', endDate: '2026-09-01' }, now));
  assert.throws(() => resolveAgentReportRange('custom', { startDate: '2024-01-01', endDate: '2026-01-01' }, now));
  assert.throws(() => resolveAgentReportRange('decade', {}, now));
  check('bad ranges refused (reversed, over a year, unknown period)', true);
}

main()
  .catch((e) => { console.error(e); results.push(false); })
  .finally(async () => {
    await wallet.destroy({ where: { userId: OWNER }, force: true }).catch((e) => console.error('cleanup', e.message));
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} passed`);
    await sequelize.close();
    process.exit(passed === results.length ? 0 : 1);
  });
