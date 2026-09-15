"use strict";

const assert = require("assert");
const {
  classifyAgentEarningChannel,
  isMixedPayChannel,
  customersWhoUsedBoth,
} = require("./earningChannel");

assert.strictEqual(classifyAgentEarningChannel({ paymentType: "cash" }), "cash");
assert.strictEqual(classifyAgentEarningChannel({ paymentType: "card" }), "card");
assert.strictEqual(
  classifyAgentEarningChannel({
    paymentType: "card",
    balanceCollectedVia: "cash",
  }),
  "cash"
);
assert.strictEqual(
  classifyAgentEarningChannel({
    paymentType: "card",
    balanceCollectedVia: "card",
    balancePaymentMethod: "cash",
  }),
  "card"
);
assert.strictEqual(
  classifyAgentEarningChannel({
    paymentType: "card",
    balancePaymentMethod: "cash",
  }),
  "cash"
);
assert.strictEqual(
  isMixedPayChannel({ paymentType: "card", balanceCollectedVia: "cash" }),
  true
);
assert.strictEqual(isMixedPayChannel({ paymentType: "cash" }), false);
assert.strictEqual(customersWhoUsedBoth(10, 8, 15), 3);
assert.strictEqual(customersWhoUsedBoth(5, 0, 5), 0);

console.log("earningChannel tests passed");
