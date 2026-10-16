'use strict';

/**
 * One customer bill for every screen (customer app, agent app, admin): the lines
 * from laundry to "Left to pay", in order, with their labels, plus a plain note
 * when the discount came out smaller than the offer. Built from a payment summary
 * (utils/invoicePaymentSummary.js) so the numbers are the same ones charged.
 */

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (sym, n) => `${sym}${round(n).toFixed(2)}`;

/**
 * @param {object} ps payment summary (enriched or not)
 * @param {object} [facts]
 * @param {number} [facts.creditUsed] customer credit inside orderSummary.discount
 * @param {number|null} [facts.offerWorth] what the promotions were worth before the
 *   "never more than is still to pay" limit (null = not known for this order)
 * @param {number} [facts.promotionDiscount] what the promotions actually took off
 * @returns {{ currency: string, currencySymbol: string, lines: Array<{ key: string,
 *   label: string, amount: number, sign: '+'|'-'|null, strong: boolean }>,
 *   leftToPay: number, nothingToPay: boolean, status: string, note: string|null,
 *   offer: { worth: number, applied: number }|null }}
 */
function buildInvoiceBill(ps = {}, facts = {}) {
  const sym = ps.currencySymbol || '£';
  const os = ps.orderSummary || {};
  const paid = ps.paidAtBooking || {};
  const isCash = ps.paymentType === 'cash';

  const laundry = round(os.laundrySubtotal ?? ps.laundrySubtotal);
  const topUp = round(os.minimumAdjustment);
  const serviceFee = round(os.serviceFee);
  const tip = round(os.driverTip);
  const totalBefore = round(os.totalOrderAmount);
  const allDiscounts = round(os.discount);
  const credit = Math.min(round(facts.creditUsed), allDiscounts);
  const discount = round(allDiscounts - credit);
  const totalAfter = round(Math.max(0, totalBefore - allDiscounts));
  const paidAtBooking = isCash ? 0 : round(paid.totalPaid);
  const paidLater = round(ps.paidLater?.totalPaid);
  const leftToPay = round(ps.amountDueNow);

  const lines = [];
  const add = (key, label, amount, sign = null, strong = false) => lines.push({ key, label, amount: round(amount), sign, strong });

  add('laundry', 'Laundry', laundry);
  if (topUp > 0) add('minimumTopUp', 'Minimum order top-up', topUp, '+');
  if (serviceFee > 0) add('serviceFee', 'Service fee', serviceFee);
  if (tip > 0) add('driverTip', 'Driver tip', tip);
  if (allDiscounts > 0) {
    add('totalBeforeDiscount', 'Total before discount', totalBefore, null, true);
    if (discount > 0) add('discount', 'Discount', discount, '-');
    if (credit > 0) add('credit', 'Credit used', credit, '-');
    add('totalAfterDiscount', 'Total after discount', totalAfter, null, true);
  } else {
    add('total', 'Total', totalBefore, null, true);
  }
  if (paidAtBooking > 0) add('paidAtBooking', 'Paid at booking', paidAtBooking, '-');
  if (paidLater > 0) add('paidLater', ps.paidLater?.label || 'Paid', paidLater, '-');
  add('leftToPay', 'Left to pay', leftToPay, null, true);

  const nothingToPay = leftToPay <= 0.02;
  let status;
  if (!nothingToPay) status = `${money(sym, leftToPay)} still to pay`;
  else if (paidAtBooking + paidLater > 0 || isCash) status = 'Nothing more to pay';
  else status = 'Nothing to pay';

  const notes = [];
  const worth = facts.offerWorth == null ? null : round(facts.offerWorth);
  const applied = round(facts.promotionDiscount);
  const limited = worth != null && worth > applied + 0.01;
  if (limited) {
    if (paidAtBooking > 0) {
      const parts = [
        round(paid.minimumOrderPayment) > 0 ? `minimum order ${money(sym, paid.minimumOrderPayment)}` : null,
        round(paid.serviceFee) > 0 ? `service fee ${money(sym, paid.serviceFee)}` : null,
        round(paid.driverTip) > 0 ? `driver tip ${money(sym, paid.driverTip)}` : null,
      ].filter(Boolean);
      notes.push(
        `This offer was worth ${money(sym, worth)}. A discount can only take off what is still to pay: ` +
        `${money(sym, paidAtBooking)} was paid at booking${parts.length ? ` (${parts.join(' + ')})` : ''}, ` +
        `so the discount is ${money(sym, applied)}.`
      );
    } else {
      notes.push(
        `This offer was worth ${money(sym, worth)}, more than this bill, so the discount is ${money(sym, applied)} ` +
        'and covers what was left to pay.'
      );
    }
  }
  if (!isCash && paidAtBooking > totalAfter + 0.01) {
    notes.push(
      `${money(sym, paidAtBooking)} was paid at booking, more than the ${money(sym, totalAfter)} total: ` +
      `the minimum order (${money(sym, paid.minimumOrderPayment)}) is the least an order costs, so the difference is not refunded.`
    );
  }

  return {
    currency: ps.currency || 'GBP',
    currencySymbol: sym,
    lines,
    leftToPay,
    nothingToPay,
    status,
    note: notes.length ? notes.join(' ') : null,
    offer: worth != null && applied > 0 ? { worth, applied } : null,
  };
}

/**
 * Add `bill` to a booking's payment summary (new optional key; old apps ignore it).
 * Never throws: a summary without a bill is still a valid summary.
 */
async function attachInvoiceBill(paymentSummary, bookingId) {
  if (!paymentSummary || !bookingId) return paymentSummary;
  try {
    const { promotionRedemption: Redemption } = require('../models');
    const credit = require('../services/promotions/customerCreditService');
    const [holds, spent] = await Promise.all([
      Redemption.findAll({
        where: { bookingId, status: ['RESERVED', 'COMMITTED'] },
        attributes: ['discountAmount', 'fullDiscountAmount'],
      }),
      credit.spentOnBooking(bookingId),
    ]);
    const priced = holds.filter((h) => h.discountAmount != null);
    const promotionDiscount = priced.reduce((s, h) => s + Number(h.discountAmount || 0), 0);
    // Worth is only known when every priced hold has it (priced after the column existed).
    const offerWorth = priced.length && priced.every((h) => h.fullDiscountAmount != null)
      ? priced.reduce((s, h) => s + Number(h.fullDiscountAmount), 0)
      : null;
    paymentSummary.bill = buildInvoiceBill(paymentSummary, {
      creditUsed: Number(spent?.amount) || 0,
      offerWorth,
      promotionDiscount,
    });
  } catch (err) {
    console.warn(`[invoiceBill] booking ${bookingId}: bill skipped`, err?.message || err);
  }
  return paymentSummary;
}

module.exports = { buildInvoiceBill, attachInvoiceBill };
