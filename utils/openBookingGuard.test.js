'use strict';

const assert = require('assert');
const { Op } = require('sequelize');
const {
  TERMINAL_FOR_ACCOUNT_BLOCK,
  openCustomerBookingWhere,
  openAssignedBookingWhere,
  openAgentOwnerBookingWhere,
} = require('./openBookingGuard');

assert.deepStrictEqual(TERMINAL_FOR_ACCOUNT_BLOCK, [17, 19, 21, 23]);

const customerWhere = openCustomerBookingWhere(44, Op);
assert.strictEqual(customerWhere.customerId, 44);
assert.deepStrictEqual(customerWhere.bookingStatusId[Op.notIn], TERMINAL_FOR_ACCOUNT_BLOCK);

const assigned = openAssignedBookingWhere(9, Op);
assert.strictEqual(assigned[Op.or].length, 2);

const withShop = openAgentOwnerBookingWhere(3, 88, Op);
assert.ok(withShop[Op.or].some((clause) => clause.laundryShopId === 88));

const withoutShop = openAgentOwnerBookingWhere(3, null, Op);
assert.ok(!withoutShop[Op.or].some((clause) => Object.prototype.hasOwnProperty.call(clause, 'laundryShopId')));

console.log('openBookingGuard tests passed');
