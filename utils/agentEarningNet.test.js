"use strict";

const assert = require("assert");
const { netAgentEarning } = require("./agentEarningNet");

assert.strictEqual(
  netAgentEarning({ billed: 80, credited: 80, clawed: 80 }),
  0,
  "full refund clawback zeros payable even if billing is still 80"
);
assert.strictEqual(
  netAgentEarning({ billed: 80, credited: 80, clawed: 0 }),
  80,
  "unrefunded credited commission stays payable"
);
assert.strictEqual(
  netAgentEarning({ billed: 80, credited: 0, clawed: 0 }),
  80,
  "pre-wallet billed earning is used until a credit posts"
);
assert.strictEqual(
  netAgentEarning({ billed: 80, credited: 80, clawed: 20 }),
  60,
  "partial refund leaves remaining commission"
);
assert.strictEqual(
  netAgentEarning({ billed: 0, credited: 80, clawed: 80 }),
  0,
  "healed-to-zero billing still nets to 0 after clawback"
);
assert.strictEqual(
  netAgentEarning({ billed: 80, credited: 0, clawed: 80 }),
  0,
  "clawback against billed-only earning still zeros it"
);

console.log("agentEarningNet tests passed");
