'use strict';

/**
 * Money emails print the booking's currency symbol passed by the caller (the zone's),
 * never a hard-coded '£'.   node tests/emailTemplateCurrency.test.js
 */

const assert = require('assert/strict');

// The templates log while loading inline images; keep the test output readable.
const log = console.log;
const error = console.error;
console.log = () => {};
console.error = () => {};
let templates;
const results = {};
try {
  templates = require('../helper/email');
  results.invoiceReady = templates.generateInvoiceReadyTemplate({ finalAmount: '12.50', currency: '€' });
  results.agentOrderInvoice = templates.generateAgentOrderInvoiceTemplate({ finalAmount: '12.50', currency: '€' });
  results.bookingConfirmation = templates.generateBookingConfirmationTemplate({ upfrontAmount: 20, currency: '€' });
} finally {
  console.log = log;
  console.error = error;
}

assert.match(results.invoiceReady.html, /Total Due: <strong>€12\.50<\/strong>/);
assert.match(results.agentOrderInvoice.html, /Invoice total: <strong>€12\.50<\/strong>/);
assert.match(results.bookingConfirmation.html, /Minimum Order Hold: <strong>€20<\/strong>/);
for (const [name, out] of Object.entries(results)) {
  assert.ok(!out.html.includes('£'), `${name}: no hard-coded £ when the booking is in €`);
}

// No currency: a caller bug, so the template throws (the outbox keeps the row as failed)
// instead of sending a wrong symbol.
for (const [fn, data] of [
  ['generateInvoiceReadyTemplate', { finalAmount: '1.00' }],
  ['generateAgentOrderInvoiceTemplate', { finalAmount: '1.00', currency: '' }],
  ['generateBookingConfirmationTemplate', { upfrontAmount: 1, currency: null }],
]) {
  assert.throws(() => templates[fn](data), {
    name: 'TypeError',
    message: new RegExp(`^${fn}: currency symbol is required`),
  });
}

console.log('emailTemplateCurrency.test.js passed');
