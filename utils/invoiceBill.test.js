'use strict';

/** Customer bill lines, totals and notes.   node utils/invoiceBill.test.js */

const assert = require('assert');
const { buildPaymentSummaryForBooking, enrichPaymentSummary } = require('./invoicePaymentSummary');
const { buildInvoiceBill } = require('./invoiceBill');

const line = (bill, key) => bill.lines.find((l) => l.key === key);
const keys = (bill) => bill.lines.map((l) => l.key);

// Order 1802-449217: card, laundry £89, fee £10, £20 minimum + £10 fee paid at booking,
// "£50 off each item" worth £89 but limited to the £69 still to pay.
{
  const ps = enrichPaymentSummary(
    buildPaymentSummaryForBooking('card', { laundrySubtotal: 89, serviceFee: 10, minimumOrderPayment: 20, driverTip: 0, discount: 69 }),
    { paymentType: 'card', billingPaymentStatus: 'Pending' }
  );
  const bill = buildInvoiceBill(ps, { offerWorth: 89, promotionDiscount: 69 });
  assert.deepStrictEqual(keys(bill), ['laundry', 'serviceFee', 'totalBeforeDiscount', 'discount', 'totalAfterDiscount', 'paidAtBooking', 'leftToPay']);
  assert.strictEqual(line(bill, 'totalBeforeDiscount').amount, 99);
  assert.strictEqual(line(bill, 'discount').amount, 69);
  assert.strictEqual(line(bill, 'discount').sign, '-');
  assert.strictEqual(line(bill, 'totalAfterDiscount').amount, 30);
  assert.strictEqual(line(bill, 'paidAtBooking').amount, 30);
  assert.strictEqual(bill.leftToPay, 0);
  assert.strictEqual(bill.status, 'Nothing more to pay');
  assert.strictEqual(
    bill.note,
    'This offer was worth £89.00. A discount can only take off what is still to pay: £30.00 was paid at booking (minimum order £20.00 + service fee £10.00), so the discount is £69.00.'
  );
  assert.deepStrictEqual(bill.offer, { worth: 89, applied: 69 });
}

// No discount: one "Total" line, balance still to pay by card
{
  const ps = buildPaymentSummaryForBooking('card', { laundrySubtotal: 40, serviceFee: 10, minimumOrderPayment: 20, driverTip: 0, discount: 0 });
  const bill = buildInvoiceBill(ps);
  assert.deepStrictEqual(keys(bill), ['laundry', 'serviceFee', 'total', 'paidAtBooking', 'leftToPay']);
  assert.strictEqual(bill.leftToPay, 20);
  assert.strictEqual(bill.status, '£20.00 still to pay');
  assert.strictEqual(bill.note, null);
}

// Discount that fits: no note
{
  const ps = buildPaymentSummaryForBooking('card', { laundrySubtotal: 40, serviceFee: 10, minimumOrderPayment: 20, driverTip: 0, discount: 4 });
  const bill = buildInvoiceBill(ps, { offerWorth: 4, promotionDiscount: 4 });
  assert.strictEqual(line(bill, 'totalAfterDiscount').amount, 46);
  assert.strictEqual(bill.leftToPay, 16);
  assert.strictEqual(bill.note, null);
}

// Cash with a minimum top-up and customer credit inside the discount
{
  const ps = buildPaymentSummaryForBooking('cash', { laundrySubtotal: 15, serviceFee: 10, minimumOrderPayment: 20, driverTip: 0, discount: 8 });
  const bill = buildInvoiceBill(ps, { creditUsed: 3, offerWorth: 5, promotionDiscount: 5 });
  assert.deepStrictEqual(keys(bill), ['laundry', 'minimumTopUp', 'serviceFee', 'totalBeforeDiscount', 'discount', 'credit', 'totalAfterDiscount', 'leftToPay']);
  assert.strictEqual(line(bill, 'minimumTopUp').amount, 5);
  assert.strictEqual(line(bill, 'discount').amount, 5);
  assert.strictEqual(line(bill, 'credit').amount, 3);
  assert.strictEqual(line(bill, 'totalAfterDiscount').amount, 22);
  assert.strictEqual(bill.leftToPay, 22);
}

// Cash offer bigger than the bill
{
  const ps = buildPaymentSummaryForBooking('cash', { laundrySubtotal: 30, serviceFee: 10, minimumOrderPayment: 20, driverTip: 0, discount: 40 });
  const bill = buildInvoiceBill(ps, { offerWorth: 60, promotionDiscount: 40 });
  assert.strictEqual(bill.leftToPay, 0);
  assert.strictEqual(bill.note, 'This offer was worth £60.00, more than this bill, so the discount is £40.00 and covers what was left to pay.');
}

// Card laundry below the minimum: paid at booking is more than the total
{
  const ps = buildPaymentSummaryForBooking('card', { laundrySubtotal: 12, serviceFee: 10, minimumOrderPayment: 20, driverTip: 0, discount: 0 });
  const bill = buildInvoiceBill(ps);
  assert.strictEqual(bill.leftToPay, 0);
  assert.match(bill.note, /minimum order \(£20\.00\) is the least an order costs/);
}

// Paid invoice balance shows as its own line; worth unknown (old order) → no note
{
  const ps = enrichPaymentSummary(
    buildPaymentSummaryForBooking('card', { laundrySubtotal: 60, serviceFee: 10, minimumOrderPayment: 20, driverTip: 0, discount: 6 }),
    { paymentType: 'card', billingPaymentStatus: 'Paid' }
  );
  const bill = buildInvoiceBill(ps, { offerWorth: null, promotionDiscount: 6 });
  assert.strictEqual(line(bill, 'paidLater').amount, 34);
  assert.strictEqual(line(bill, 'paidLater').label, 'Paid by card');
  assert.strictEqual(bill.leftToPay, 0);
  assert.strictEqual(bill.status, 'Nothing more to pay');
  assert.strictEqual(bill.note, null);
}

console.log('invoiceBill.test.js passed');
