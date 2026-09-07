'use strict';

const {
  booking,
  billingDetails,
  invoicePaymentAttempt,
  tip,
  wallet,
  bookingRefund,
  bookingHistory,
  users,
} = require('../../models');
const { sendNotification } = require('../../utils/notification');
const {
  ValidationError,
  NotFoundError,
} = require('../../middlewares/universalErrorHandler');
const {
  refundPaymentIntent,
  getIntent,
  listPaymentIntentsForCustomer,
} = require('../../controllers/stripe');
const {
  summarizeTips,
  TIP_SOURCE,
} = require('../../utils/bookingTips');
const {
  classifyAgentEarningChannel,
  resolveShopOwnerUserId,
  getNetCommissionForBooking,
  getNetCashCollectedForBooking,
  getNetExtraTipForBooking,
  clawbackCommissionForRefund,
  reverseCashCollectedForRefund,
  clawbackExtraTipForRefund,
  getWalletSummary,
} = require('../Agent/agentWalletService');
const { REFUNDED } = require('../../constants/bookingStatusIds');

function money(n) {
  const v = parseFloat(n || 0);
  return parseFloat((Number.isFinite(v) ? v : 0).toFixed(2));
}

function centsToMajor(cents) {
  return money(Number(cents || 0) / 100);
}

async function loadBookingForRefund(bookingId) {
  const row = await booking.findByPk(bookingId, {
    attributes: [
      'id',
      'orderTrackId',
      'customerId',
      'laundryShopId',
      'zoneId',
      'bookingStatusId',
      'paymentIntentId',
      'pickupPaymentIntentId',
      'paymentConfirmed',
      'paymentType',
      'balancePaymentMethod',
      'balanceCollectedVia',
      'orderAmount',
      'subTotal',
      'invoiceStatus',
    ],
    include: [
      {
        model: billingDetails,
        as: 'billingDetail',
        required: false,
      },
      {
        model: tip,
        as: 'tips',
        required: false,
      },
      {
        model: invoicePaymentAttempt,
        as: 'invoicePaymentAttempts',
        required: false,
      },
      {
        model: bookingRefund,
        as: 'refunds',
        required: false,
      },
      {
        model: users,
        as: 'customer',
        required: false,
        attributes: ['id', 'stripeCustomerId'],
      },
    ],
  });
  if (!row) throw new NotFoundError('Booking not found');
  return row;
}

async function piRefundable(paymentIntentId) {
  if (!paymentIntentId) {
    return { paymentIntentId: null, refundable: 0, received: 0, refunded: 0, status: null };
  }
  try {
    const intent = await getIntent(paymentIntentId);
    if (!intent) {
      return { paymentIntentId, refundable: 0, received: 0, refunded: 0, status: 'missing' };
    }
    if (intent.status !== 'succeeded') {
      return {
        paymentIntentId,
        refundable: 0,
        received: centsToMajor(intent.amount_received || intent.amount),
        refunded: centsToMajor(intent.amount_refunded),
        status: intent.status,
      };
    }
    const received = Number(intent.amount_received || 0);
    const refunded = Number(intent.amount_refunded || 0);
    return {
      paymentIntentId,
      refundable: centsToMajor(Math.max(0, received - refunded)),
      received: centsToMajor(received),
      refunded: centsToMajor(refunded),
      status: intent.status,
    };
  } catch (err) {
    return {
      paymentIntentId,
      refundable: 0,
      received: 0,
      refunded: 0,
      status: 'error',
      error: err.message,
    };
  }
}

const PICKUP_CHARGE_TYPES = new Set(['pickup', 'booking_auth_hold']);

function chargeTypeFromIntent(intent) {
  return String(intent?.metadata?.chargeType || '').toLowerCase();
}

function isPickupChargeType(chargeType) {
  return PICKUP_CHARGE_TYPES.has(String(chargeType || '').toLowerCase());
}

function labelForChargeType(chargeType, fallback) {
  const type = String(chargeType || '').toLowerCase();
  if (isPickupChargeType(type)) {
    return 'Pickup prepaid (minimum + service fee)';
  }
  if (type === 'delivery_balance') {
    return 'Invoice / delivery balance';
  }
  return fallback;
}

function intentMatchesBooking(intent, bookingRow) {
  const meta = intent?.metadata || {};
  const bookingId = String(bookingRow.id);
  const trackId = String(bookingRow.orderTrackId || '');
  if (meta.bookingId && String(meta.bookingId) === bookingId) return true;
  if (trackId && meta.orderTrackId && String(meta.orderTrackId) === trackId) {
    return true;
  }
  return false;
}

async function persistPickupPaymentIntentId(bookingRow, paymentIntentId) {
  if (!paymentIntentId || bookingRow.pickupPaymentIntentId === paymentIntentId) {
    return;
  }
  try {
    await booking.update(
      { pickupPaymentIntentId: paymentIntentId },
      { where: { id: bookingRow.id } }
    );
    bookingRow.pickupPaymentIntentId = paymentIntentId;
  } catch (err) {
    console.error(
      `[adminRefund] failed to persist pickupPaymentIntentId for booking ${bookingRow.id}:`,
      err.message
    );
  }
}

/**
 * Discover refundable charge buckets for a booking.
 * Invoice attempts + pickup PI + booking PI + Stripe customer list
 * (invoice success used to overwrite paymentIntentId and hide prepaid).
 */
async function collectChargeBuckets(bookingRow) {
  const buckets = [];
  const seen = new Set();

  const addPiBucket = async ({ key, kind, label, extra = {}, paymentIntentId }) => {
    if (!paymentIntentId || seen.has(paymentIntentId)) return;
    seen.add(paymentIntentId);
    const live = await piRefundable(paymentIntentId);
    buckets.push({
      key,
      kind,
      label,
      channel: 'card',
      ...extra,
      ...live,
    });
  };

  const attempts = (Array.isArray(bookingRow.invoicePaymentAttempts)
    ? bookingRow.invoicePaymentAttempts
    : []
  ).filter((a) => a.status === 'succeeded' && a.paymentIntentId);
  for (const attempt of attempts) {
    await addPiBucket({
      key: `invoice_${attempt.id}`,
      kind: 'invoice_charge',
      label: `Invoice charge #${attempt.attemptNumber || attempt.id}`,
      extra: {
        attemptType: attempt.attemptType,
        amountRecorded: money(attempt.amount),
      },
      paymentIntentId: attempt.paymentIntentId,
    });
  }

  if (bookingRow.pickupPaymentIntentId) {
    await addPiBucket({
      key: 'pickup_payment_intent',
      kind: 'pickup_prepaid',
      label: 'Pickup prepaid (minimum + service fee)',
      paymentIntentId: bookingRow.pickupPaymentIntentId,
    });
  }

  if (bookingRow.paymentIntentId) {
    await addPiBucket({
      key: 'booking_payment_intent',
      kind: 'booking_capture',
      label: 'Booking / latest card capture',
      paymentIntentId: bookingRow.paymentIntentId,
    });
  }

  const tips = Array.isArray(bookingRow.tips) ? bookingRow.tips : [];
  for (const tipRow of tips) {
    const isExtra =
      String(tipRow.source || '').toLowerCase() === TIP_SOURCE.POST_COMPLETE;
    const pi = tipRow.stripePaymentIntentId;
    if (!pi || seen.has(pi)) continue;
    seen.add(pi);
    const live = await piRefundable(pi);
    buckets.push({
      key: `tip_${tipRow.id}`,
      kind: isExtra ? 'extra_tip' : 'booking_tip',
      label: isExtra ? 'Extra tip (after delivery)' : 'Booking tip',
      channel: tipRow.paymentType === 'cash' ? 'cash' : 'card',
      tipId: tipRow.id,
      tipAmount: money(tipRow.amount),
      amountRecorded: money(tipRow.amount),
      ...live,
    });
  }

  const stripeCustomerId = bookingRow.customer?.stripeCustomerId;
  if (stripeCustomerId) {
    const intents = await listPaymentIntentsForCustomer(stripeCustomerId);
    for (const intent of intents) {
      if (!intent?.id || seen.has(intent.id)) continue;
      if (!intentMatchesBooking(intent, bookingRow)) continue;
      const chargeType = chargeTypeFromIntent(intent);
      const kind = isPickupChargeType(chargeType)
        ? 'pickup_prepaid'
        : chargeType === 'delivery_balance'
          ? 'invoice_charge'
          : 'card_charge';
      await addPiBucket({
        key: `stripe_${intent.id}`,
        kind,
        label: labelForChargeType(chargeType, 'Card charge for this order'),
        extra: { chargeType, amountRecorded: centsToMajor(intent.amount_received || intent.amount) },
        paymentIntentId: intent.id,
      });
    }
  }

  const discoveredPickup = buckets.find(
    (b) => isPickupChargeType(b.chargeType) || b.kind === 'pickup_prepaid'
  );
  if (discoveredPickup?.paymentIntentId && !bookingRow.pickupPaymentIntentId) {
    await persistPickupPaymentIntentId(bookingRow, discoveredPickup.paymentIntentId);
  }

  const kindRank = (kind) => {
    if (kind === 'pickup_prepaid') return 0;
    if (kind === 'invoice_charge' || kind === 'booking_capture') return 1;
    if (kind === 'booking_tip') return 2;
    if (kind === 'extra_tip') return 3;
    return 4;
  };
  buckets.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));

  return buckets;
}

async function buildRefundPreview(bookingId, requestedAmount = null) {
  const bookingRow = await loadBookingForRefund(bookingId);
  const billing = bookingRow.billingDetail;
  const tipsSummary = summarizeTips(bookingRow.tips);
  const channel = classifyAgentEarningChannel(bookingRow);
  const agentUserId = await resolveShopOwnerUserId(bookingRow.laundryShopId);

  const chargeBuckets = await collectChargeBuckets(bookingRow);
  const cardRefundable = money(
    chargeBuckets.reduce((s, b) => s + (b.channel === 'card' ? b.refundable : 0), 0)
  );

  const priorRefunds = (bookingRow.refunds || []).map((r) => ({
    id: r.id,
    amount: money(r.amount),
    mode: r.mode,
    channel: r.channel,
    reason: r.reason,
    commissionClawback: money(r.commissionClawback),
    cashCollectedReversal: money(r.cashCollectedReversal),
    extraTipClawback: money(r.extraTipClawback),
    refundSharePercent: money(r.refundSharePercent),
    createdAt: r.createdAt,
    status: r.status,
  }));
  const alreadyRefundedAdmin = money(
    priorRefunds.reduce((s, r) => s + r.amount, 0)
  );

  const netCashCollected = agentUserId
    ? await getNetCashCollectedForBooking(bookingId)
    : 0;
  const walletCommission = agentUserId
    ? await getNetCommissionForBooking(bookingId)
    : 0;
  // Wallet is source of truth once posted; billing is the fallback before credit.
  const netCommission = money(
    walletCommission > 0.009 ? walletCommission : billing?.agentEarning
  );
  const netExtraTip = agentUserId
    ? await getNetExtraTipForBooking(bookingId)
    : money(tipsSummary.extraTipAmount);

  const cashRefundable = channel === 'cash' || netCashCollected > 0
    ? netCashCollected
    : 0;

  const refundableNow = money(cardRefundable + cashRefundable);

  const agentEarningOriginal = money(billing?.agentEarning);
  const platformShareOriginal = money(billing?.zoneAdminCommission);
  const serviceFee = money(billing?.serviceCharge);
  const laundryHint = money(
    (billing?.total || bookingRow.orderAmount || 0) - serviceFee - tipsSummary.bookingTipAmount
  );

  const amount =
    requestedAmount == null || requestedAmount === ''
      ? refundableNow
      : money(requestedAmount);

  if (amount < 0) {
    throw new ValidationError('Refund amount cannot be negative');
  }
  if (amount - refundableNow > 0.009) {
    throw new ValidationError(
      `Refund amount £${amount.toFixed(2)} exceeds refundable £${refundableNow.toFixed(2)}`
    );
  }

  // This refund vs remaining refundable. Booking tip lives inside agentEarning /
  // booking_commission, so a full remaining refund claws 100% of net commission.
  const share = refundableNow > 0 ? Math.min(1, amount / refundableNow) : 0;
  const sharePercent = money(share * 100);

  // Allocate card portion first, then cash.
  let remaining = amount;
  const cardPortion = money(Math.min(remaining, cardRefundable));
  remaining = money(remaining - cardPortion);
  const cashPortion = money(Math.min(remaining, cashRefundable));

  const allocations = [];
  let left = cardPortion;
  for (const bucket of chargeBuckets) {
    if (bucket.channel !== 'card' || bucket.refundable <= 0 || left <= 0) continue;
    const take = money(Math.min(left, bucket.refundable));
    if (take <= 0) continue;
    allocations.push({
      ...bucket,
      allocate: take,
    });
    left = money(left - take);
  }
  if (cashPortion > 0) {
    allocations.push({
      key: 'cash_manual',
      kind: 'cash_collected',
      label: 'Cash collected (manual return to customer)',
      channel: 'cash',
      paymentIntentId: null,
      refundable: cashRefundable,
      allocate: cashPortion,
    });
  }

  const extraTipAllocated = money(
    allocations
      .filter((a) => a.kind === 'extra_tip')
      .reduce((s, a) => s + a.allocate, 0)
  );

  const projectedCommissionClawback = money(
    Math.min(netCommission, netCommission * share)
  );
  const projectedPlatformClawback = money(
    Math.min(platformShareOriginal, platformShareOriginal * share)
  );
  const projectedCashReversal = cashPortion;
  const projectedExtraTipClawback = money(
    Math.min(netExtraTip, extraTipAllocated)
  );

  let agentSettlementAfter = null;
  if (agentUserId) {
    try {
      const summary = await getWalletSummary(agentUserId);
      agentSettlementAfter = {
        before: {
          cashDueToPlatform: money(summary.cashDueToPlatform),
          platformOwesAgent: money(summary.platformOwesAgent),
          totalEarning: money(summary.totalEarning),
          totalEarningCard: money(summary.totalEarningCard),
          totalEarningCash: money(summary.totalEarningCash),
          totalCashCollected: money(summary.totalCashCollected),
        },
        projectedDelta: {
          // Cash due = cash_collected − commission. Reversing cash and clawing
          // commission nets to zero on a full cash refund. Card has no cash due.
          cashDueToPlatform:
            cashPortion > 0
              ? money(-projectedCashReversal + projectedCommissionClawback)
              : 0,
          platformOwesAgent: money(
            -(channel === 'card' ? projectedCommissionClawback : 0) -
              projectedExtraTipClawback
          ),
          agentEarning: money(-projectedCommissionClawback),
          cashCollectedNet: money(-projectedCashReversal),
        },
      };
    } catch (_) {
      agentSettlementAfter = null;
    }
  }

  const eligible =
    refundableNow > 0.009 &&
    (money(billing?.total) > 0 ||
      bookingRow.paymentConfirmed ||
      billing?.paymentStatus === 'Paid' ||
      chargeBuckets.some((b) => b.refundable > 0) ||
      netCashCollected > 0);

  return {
    bookingId: bookingRow.id,
    orderTrackId: bookingRow.orderTrackId,
    bookingStatusId: bookingRow.bookingStatusId,
    currency: 'GBP',
    eligible,
    eligibilityMessage: eligible
      ? null
      : 'Nothing refundable on this order (no successful card capture or cash collected).',
    paymentChannel: channel,
    paymentType: bookingRow.paymentType,
    billingPaymentStatus: billing?.paymentStatus || null,
    economics: {
      orderTotal: money(billing?.total || bookingRow.orderAmount),
      laundrySubtotalHint: laundryHint,
      serviceFee,
      serviceFeeKeptBy: 'returned_to_customer_if_in_stripe_charge',
      bookingTip: money(tipsSummary.bookingTipAmount),
      bookingTipTo: 'agent_100_percent',
      extraTip: money(tipsSummary.extraTipAmount),
      extraTipTo: 'agent_100_percent',
      agentEarningOriginal,
      agentEarningNetNow: netCommission,
      platformShareOriginal,
      agentCommissionNote:
        'Agent earning = laundry share (zone %) + booking tip. Service fee stays with platform.',
    },
    charges: chargeBuckets,
    cash: {
      netCollected: netCashCollected,
      refundable: cashRefundable,
      note: 'Cash refunds are marked in-app; Stripe is not used. Staff must return cash to the customer.',
    },
    alreadyRefunded: alreadyRefundedAdmin,
    priorRefunds,
    refundableNow,
    requestedAmount: amount,
    mode: amount >= refundableNow - 0.009 ? 'full' : 'partial',
    refundSharePercent: sharePercent,
    allocations,
    impact: {
      customerReceives: {
        cardViaStripe: cardPortion,
        cashManual: cashPortion,
        total: amount,
      },
      agent: {
        commissionClawback: projectedCommissionClawback,
        commissionClawbackPercentOfNet: netCommission
          ? money((projectedCommissionClawback / netCommission) * 100)
          : 0,
        remainingCommission: money(netCommission - projectedCommissionClawback),
        extraTipClawback: projectedExtraTipClawback,
        remainingExtraTip: money(netExtraTip - projectedExtraTipClawback),
        cashCollectedReversal: projectedCashReversal,
        remainingCashCollected: money(netCashCollected - projectedCashReversal),
      },
      platform: {
        platformShareClawback: projectedPlatformClawback,
        remainingPlatformShare: money(
          platformShareOriginal - projectedPlatformClawback
        ),
        serviceFeeUnchanged: serviceFee,
        stripeOutflow: cardPortion,
      },
      settlement: agentSettlementAfter,
    },
  };
}

function allocateAmountAcrossBuckets(preview, amount) {
  // Recompute allocations for exact amount from preview buckets.
  const cardRefundable = money(
    preview.charges.reduce(
      (s, b) => s + (b.channel === 'card' ? b.refundable : 0),
      0
    )
  );
  const cashRefundable = money(preview.cash.refundable);
  let remaining = money(amount);
  const cardPortion = money(Math.min(remaining, cardRefundable));
  remaining = money(remaining - cardPortion);
  const cashPortion = money(Math.min(remaining, cashRefundable));

  const allocations = [];
  let left = cardPortion;
  for (const bucket of preview.charges) {
    if (bucket.channel !== 'card' || bucket.refundable <= 0 || left <= 0) continue;
    const take = money(Math.min(left, bucket.refundable));
    if (take <= 0) continue;
    allocations.push({ ...bucket, allocate: take });
    left = money(left - take);
  }
  if (cashPortion > 0) {
    allocations.push({
      key: 'cash_manual',
      kind: 'cash_collected',
      label: 'Cash collected (manual return to customer)',
      channel: 'cash',
      paymentIntentId: null,
      refundable: cashRefundable,
      allocate: cashPortion,
    });
  }
  return { allocations, cardPortion, cashPortion };
}

async function issueRefund(bookingId, payload = {}, adminUserId = null) {
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new ValidationError('Refund reason is required');

  const note = payload.note != null ? String(payload.note).trim() : null;
  const idempotencyKey =
    payload.idempotencyKey ||
    `admin-refund-${bookingId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const existing = await bookingRefund.findOne({
    where: { idempotencyKey },
  });
  if (existing) {
    return {
      message: 'Refund already processed (idempotent replay)',
      refund: existing,
      replay: true,
    };
  }

  const preview = await buildRefundPreview(
    bookingId,
    payload.amount != null ? payload.amount : undefined
  );
  if (!preview.eligible) {
    throw new ValidationError(preview.eligibilityMessage || 'Refund not allowed');
  }

  const amount =
    payload.mode === 'full' || payload.amount == null || payload.amount === ''
      ? preview.refundableNow
      : money(payload.amount);

  if (amount <= 0) throw new ValidationError('Refund amount must be greater than zero');
  if (amount - preview.refundableNow > 0.009) {
    throw new ValidationError(
      `Refund amount exceeds refundable £${preview.refundableNow.toFixed(2)}`
    );
  }

  const livePreview = await buildRefundPreview(bookingId, amount);
  const { allocations, cardPortion, cashPortion } = allocateAmountAcrossBuckets(
    livePreview,
    amount
  );

  const bookingRow = await loadBookingForRefund(bookingId);
  const agentUserId = await resolveShopOwnerUserId(bookingRow.laundryShopId);
  const orderLabel = bookingRow.orderTrackId || String(bookingId);
  const customerId = bookingRow.customerId;

  const stripeRefundIds = [];
  const paymentAllocations = [];
  let stripeFailed = null;

  for (const alloc of allocations) {
    if (alloc.channel !== 'card' || !alloc.paymentIntentId || !(alloc.allocate > 0)) {
      if (alloc.channel === 'cash' && alloc.allocate > 0) {
        paymentAllocations.push({
          kind: alloc.kind,
          channel: 'cash',
          amount: alloc.allocate,
          stripeRefundId: null,
          status: 'manual_cash',
        });
      }
      continue;
    }
    try {
      const refund = await refundPaymentIntent(alloc.paymentIntentId, alloc.allocate, {
        reason: 'requested_by_customer',
        idempotencyKey: `${idempotencyKey}-${alloc.key}`.slice(0, 255),
        metadata: {
          bookingId: String(bookingId),
          orderTrackId: orderLabel,
          type: 'admin_invoice_refund',
          kind: alloc.kind,
          adminUserId: adminUserId != null ? String(adminUserId) : '',
        },
      });
      const refundedMajor = refund?.alreadyRefunded
        ? 0
        : refund?.amount != null
          ? centsToMajor(refund.amount)
          : alloc.allocate;
      if (refund?.id) stripeRefundIds.push(refund.id);
      paymentAllocations.push({
        kind: alloc.kind,
        channel: 'card',
        paymentIntentId: alloc.paymentIntentId,
        amount: refundedMajor || alloc.allocate,
        stripeRefundId: refund?.id || null,
        status: refund?.alreadyRefunded ? 'already_refunded' : refund?.status || 'succeeded',
      });

      if (refundedMajor > 0 && customerId) {
        try {
          await wallet.create({
            userId: customerId,
            bookingId,
            referenceType: 'customer_refund',
            amount: refundedMajor,
            type: 'credit',
            description: `Admin refund (${alloc.kind}) for order #${orderLabel}`,
            currency: 'GBP',
            status: 'completed',
          });
        } catch (walletErr) {
          console.error(
            `⚠️ Customer wallet ledger failed after admin refund booking ${bookingId}:`,
            walletErr.message
          );
        }
      }
    } catch (err) {
      stripeFailed = err.message;
      paymentAllocations.push({
        kind: alloc.kind,
        channel: 'card',
        paymentIntentId: alloc.paymentIntentId,
        amount: alloc.allocate,
        stripeRefundId: null,
        status: 'failed',
        error: err.message,
      });
      break;
    }
  }

  if (stripeFailed && paymentAllocations.every((a) => a.status === 'failed')) {
    throw new ValidationError(`Stripe refund failed: ${stripeFailed}`);
  }

  const impact = livePreview.impact;
  const commissionClawback = impact.agent.commissionClawback;
  const platformShareClawback = impact.platform.platformShareClawback;
  const cashCollectedReversal = impact.agent.cashCollectedReversal;
  const extraTipClawback = impact.agent.extraTipClawback;

  const channel =
    cardPortion > 0 && cashPortion > 0
      ? 'mixed'
      : cashPortion > 0
        ? 'cash'
        : 'card';

  const refundRow = await bookingRefund.create({
    bookingId,
    adminUserId: adminUserId || null,
    mode: amount >= livePreview.refundableNow - 0.009 ? 'full' : 'partial',
    channel,
    amount,
    currency: 'GBP',
    reason,
    note,
    stripeRefundIds,
    paymentAllocations,
    commissionClawback,
    platformShareClawback,
    cashCollectedReversal,
    extraTipClawback,
    refundSharePercent: livePreview.refundSharePercent,
    breakdown: livePreview,
    status: stripeFailed ? 'partial_failed' : 'succeeded',
    idempotencyKey,
  });

  if (agentUserId) {
    await clawbackCommissionForRefund({
      bookingId,
      agentUserId,
      amount: commissionClawback,
      currency: 'GBP',
      orderLabel,
      refundId: refundRow.id,
    });
    await reverseCashCollectedForRefund({
      bookingId,
      agentUserId,
      amount: cashCollectedReversal,
      currency: 'GBP',
      orderLabel,
      refundId: refundRow.id,
    });
    await clawbackExtraTipForRefund({
      bookingId,
      agentUserId,
      amount: extraTipClawback,
      currency: 'GBP',
      orderLabel,
      refundId: refundRow.id,
    });
  }

  // Keep billing earnings in sync so settlement totals / order detail stay accurate.
  const billing = bookingRow.billingDetail;
  if (billing && (commissionClawback > 0 || platformShareClawback > 0)) {
    const nextAgent = money(
      Math.max(0, money(billing.agentEarning) - commissionClawback)
    );
    const nextPlatform = money(
      Math.max(0, money(billing.zoneAdminCommission) - platformShareClawback)
    );
    await billingDetails.update(
      {
        agentEarning: nextAgent,
        zoneAdminCommission: nextPlatform,
      },
      { where: { bookingId } }
    );
  }

  // Full remaining refund → Refunded status.
  const after = await buildRefundPreview(bookingId);
  if (after.refundableNow <= 0.02 && bookingRow.bookingStatusId !== REFUNDED) {
    await booking.update(
      { bookingStatusId: REFUNDED },
      { where: { id: bookingId } }
    );
    const now = new Date();
    try {
      await bookingHistory.create({
        bookingId,
        date: now.toISOString().slice(0, 10),
        time: now.toTimeString().slice(0, 5),
        bookingStatusId: REFUNDED,
      });
    } catch (histErr) {
      console.error(
        `[adminRefund] booking history failed booking ${bookingId}:`,
        histErr.message
      );
    }
  }

  notifyRefundParties({
    bookingRow,
    amount,
    channel,
    mode: refundRow.mode,
    reason,
    commissionClawback,
    cashCollectedReversal,
    agentUserId,
    remainingRefundable: after.refundableNow,
  });

  let settlement = null;
  if (agentUserId) {
    try {
      settlement = await getWalletSummary(agentUserId);
    } catch (_) {
      settlement = null;
    }
  }

  return {
    message: 'Refund issued',
    refund: refundRow,
    preview: livePreview,
    remainingRefundable: after.refundableNow,
    bookingStatusId:
      after.refundableNow <= 0.02 ? REFUNDED : bookingRow.bookingStatusId,
    settlement: settlement
      ? {
          cashDueToPlatform: money(settlement.cashDueToPlatform),
          platformOwesAgent: money(settlement.platformOwesAgent),
          totalEarning: money(settlement.totalEarning),
        }
      : null,
  };
}

async function listRefundsForBooking(bookingId) {
  const rows = await bookingRefund.findAll({
    where: { bookingId },
    order: [['id', 'DESC']],
    include: [
      {
        model: users,
        as: 'admin',
        attributes: ['id', 'firstName', 'lastName', 'email'],
        required: false,
      },
    ],
  });
  return rows;
}

function publicRefundItem(row) {
  return {
    id: row.id,
    amount: money(row.amount),
    mode: row.mode,
    channel: row.channel,
    reason: row.reason || null,
    createdAt: row.createdAt,
    status: row.status,
  };
}

async function getPublicRefundSummary(bookingId) {
  const rows = await bookingRefund.findAll({
    where: { bookingId },
    attributes: [
      'id',
      'amount',
      'mode',
      'channel',
      'reason',
      'createdAt',
      'status',
    ],
    order: [['id', 'DESC']],
  });
  const history = rows.map(publicRefundItem);
  const totalRefunded = money(history.reduce((s, r) => s + r.amount, 0));
  return {
    totalRefunded,
    count: history.length,
    isFullyRefunded: false,
    latest: history[0] || null,
    history,
  };
}

function notifyRefundParties({
  bookingRow,
  amount,
  channel,
  mode,
  reason,
  commissionClawback,
  cashCollectedReversal,
  agentUserId,
  remainingRefundable,
}) {
  const orderLabel = bookingRow.orderTrackId || String(bookingRow.id);
  const amountLabel = money(amount).toFixed(2);
  const isCash = channel === 'cash' || channel === 'mixed';
  const isFull = mode === 'full' || remainingRefundable <= 0.02;
  const customerTitle = isFull ? 'Refund issued' : 'Partial refund issued';
  const customerBody = isCash
    ? `£${amountLabel} cash refund is recorded for order ${orderLabel}. Please collect it from the shop or driver.`
    : `£${amountLabel} has been refunded to your card for order ${orderLabel}. It can take a few working days to appear on your statement.`;

  const payload = {
    bookingId: String(bookingRow.id),
    orderId: String(bookingRow.id),
    orderTrackId: String(bookingRow.orderTrackId || ''),
    type: 'ORDER_REFUNDED',
    amount: amountLabel,
    mode: String(mode || ''),
    channel: String(channel || ''),
    remainingRefundable: money(remainingRefundable).toFixed(2),
  };

  if (bookingRow.customerId) {
    sendNotification(
      bookingRow.customerId,
      customerTitle,
      customerBody,
      payload
    ).catch((err) =>
      console.error(
        `[adminRefund] customer notify failed booking ${bookingRow.id}:`,
        err.message
      )
    );
  }

  if (agentUserId) {
    const claw = money(commissionClawback).toFixed(2);
    const cashBack = money(cashCollectedReversal).toFixed(2);
    const agentTitle = `Refund on order ${orderLabel}`;
    const agentBody = isCash
      ? `Admin recorded a £${amountLabel} cash refund. Return £${cashBack} cash to the customer. Your commission on this order is reduced by £${claw}.`
      : `Admin refunded £${amountLabel} to the customer. Your commission on this order is reduced by £${claw}.`;
    sendNotification(agentUserId, agentTitle, agentBody, {
      ...payload,
      type: 'ORDER_UPDATE',
      commissionClawback: claw,
      cashToReturn: cashBack,
      reason: String(reason || '').slice(0, 120),
    }).catch((err) =>
      console.error(
        `[adminRefund] agent notify failed booking ${bookingRow.id}:`,
        err.message
      )
    );
  }
}

module.exports = {
  buildRefundPreview,
  issueRefund,
  listRefundsForBooking,
  getPublicRefundSummary,
};
