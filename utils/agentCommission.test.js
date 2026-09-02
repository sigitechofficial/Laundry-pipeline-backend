'use strict';

const assert = require('assert');
const {
    resolveAgentCommissionBase,
    calculateAgentCommissionAmounts,
} = require('./agentCommission');

function runTests() {
    assert.strictEqual(
        resolveAgentCommissionBase(50, 25, 'card'),
        50,
        'card commission base is laundry only'
    );
    assert.strictEqual(
        resolveAgentCommissionBase(15, 25, 'cash'),
        25,
        'cash commission base floors at zone minimum'
    );

    const withTip = calculateAgentCommissionAmounts(50, 80, 5);
    assert.strictEqual(withTip.laundryAgentShare, 40);
    assert.strictEqual(withTip.agentEarning, 45, 'tip is added in full to the agent');
    assert.strictEqual(withTip.platformCommissionAmount, 10, 'platform does not take tip');
    assert.strictEqual(withTip.driverTip, 5);

    const noTip = calculateAgentCommissionAmounts(50, 80, 0);
    assert.strictEqual(noTip.agentEarning, 40);
    assert.strictEqual(noTip.platformCommissionAmount, 10);

    const defaultArg = calculateAgentCommissionAmounts(50, 80);
    assert.strictEqual(defaultArg.agentEarning, 40);

    console.log('agentCommission.test.js: all assertions passed');
}

runTests();
