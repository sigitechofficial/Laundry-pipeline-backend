"use strict";

const assert = require("assert");
const {
    generateOrderTrackId,
    hasFullOrderTrackId,
} = require("./orderTrackId");

function runTests() {
    assert.strictEqual(hasFullOrderTrackId(null), false);
    assert.strictEqual(hasFullOrderTrackId(""), false);
    assert.strictEqual(hasFullOrderTrackId(1443), false);
    assert.strictEqual(hasFullOrderTrackId("1443"), false);
    assert.strictEqual(hasFullOrderTrackId("1440-373935"), true);

    const generated = generateOrderTrackId(1443);
    assert.strictEqual(hasFullOrderTrackId(generated), true);
    assert.ok(generated.startsWith("1443-"));

    console.log("orderTrackId.test.js: all assertions passed");
}

runTests();
