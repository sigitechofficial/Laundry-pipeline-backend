const assert = require('assert');
const { onHoldCustomerState } = require('./onHoldCustomerState');

const open = { responseConformation: false, deleted: false };
const answered = { responseConformation: true, deleted: false };
const removed = { responseConformation: false, deleted: true };

assert.deepStrictEqual(onHoldCustomerState(18, [open, answered]), { total: 2, waitingItems: 1, resolved: false, waiting: true });
assert.strictEqual(onHoldCustomerState(18, [answered]).resolved, true, 'all answered -> resolved');
assert.strictEqual(onHoldCustomerState(18, [removed]).resolved, true, 'taken off by the shop -> resolved');
assert.strictEqual(onHoldCustomerState(11, [open]).resolved, true, 'order moved on -> resolved');
assert.strictEqual(onHoldCustomerState('18', [{ responseConformation: 0, deleted: 0 }]).waiting, true, 'MariaDB 0/1 and string ids');
assert.deepStrictEqual(onHoldCustomerState(18, []), { total: 0, waitingItems: 0, resolved: false, waiting: false });
console.log('onHoldCustomerState tests passed');
