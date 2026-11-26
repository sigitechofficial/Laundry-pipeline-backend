'use strict';
const assert = require('assert');
const S = require('./onHoldSummary');

const shirt = { id: 1, noOfItems: 1, service: { name: 'Dry Clean' }, subCategory: { name: 'Silk Shirt' },
    description: 'Risk: Colour may run or fade. Note: Dye near collar.' };
const dress = { id: 2, noOfItems: 2, service: { name: 'Dry Clean' }, subCategory: { name: 'Evening Dress' },
    description: 'Risk: Other (see note). Note: Zip is broken' };

let p = S.parseOnHoldDescription('Risk: May shrink. Note: Wool.\nCustomer: go ahead');
assert.deepStrictEqual(p, { risk: 'May shrink', shopNote: 'Wool.', legacyCustomerNote: 'go ahead' });
assert.strictEqual(S.parseOnHoldDescription('Stain').shopNote, 'Stain');
assert.strictEqual(S.parseOnHoldDescription(null).shopNote, null);

assert.strictEqual(S.itemLabel(dress), 'Dry Clean · Evening Dress (×2)');
assert.strictEqual(S.issueText(dress), 'Zip is broken');
assert.strictEqual(S.summarizeOnHold([shirt, dress]), 'Dry Clean · Silk Shirt: Colour may run or fade (+1 more)');
assert.strictEqual(S.summarizeOnHold([{ ...shirt, deleted: true }]), null);
assert.match(S.onHoldPushBody([shirt], '12-345'), /Dry Clean · Silk Shirt: Colour may run or fade in order #12-345/);

const a = S.toAdminOnHoldItem({ ...shirt, responseConformation: true, customerResponse: false, customerNote: ' keep it ', respondedAt: 'x' });
assert.strictEqual(a.customerKeeps, false);
assert.strictEqual(a.customerNote, 'keep it');
assert.strictEqual(S.toAdminOnHoldItem(shirt).customerAnswer, 'Waiting for the customer');

console.log('onHoldSummary tests passed');
