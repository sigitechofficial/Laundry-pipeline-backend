"use strict";

const assert = require("assert");
const { shopCollectedNetRevenueSql } = require("./shopCollectedRevenue");

const sql = shopCollectedNetRevenueSql("addressDb.id");

assert.match(sql, /booking_refunds/, "must net customer refunds");
assert.match(sql, /bookingStatusId IN \(16, 17\)/, "only collected statuses");
assert.match(sql, /addressDb\.id/, "scoped to the shop address");
assert.match(sql, /0\.02/, "fully refunded leftover on Completed is excluded");
assert.doesNotMatch(sql, /SUM\(orderAmount\)/, "must not sum every booking");

console.log("shopCollectedRevenue tests passed");
