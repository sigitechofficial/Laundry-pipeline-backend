'use strict';

const assert = require('assert/strict');
const { resolveCancelReasonId } = require('./cancelReason');

class TestValidationError extends Error {}
const makeError = (message) => new TestValidationError(message);

async function main() {
    const lookups = [];
    const reasons = new Map([[4, { id: 4, cancelReason: 'Changed my mind' }]]);
    const find = async (id) => {
        lookups.push(id);
        return reasons.get(id) || null;
    };

    // No reason chosen (e.g. no reasons configured): stored as NULL, no lookup.
    for (const missing of [undefined, null, '']) {
        assert.equal(await resolveCancelReasonId(missing, find, makeError), null);
    }
    assert.deepEqual(lookups, []);

    // Existing reason, as number or numeric string.
    assert.equal(await resolveCancelReasonId(4, find, makeError), 4);
    assert.equal(await resolveCancelReasonId('4', find, makeError), 4);

    // The captured request that failed with a 500: {bookingId: 182, reasonId: 1,
    // reasonText: 'Scenario 3 cancellation test'} while the reasons table was empty.
    await assert.rejects(
        resolveCancelReasonId(1, find, makeError),
        (e) => e instanceof TestValidationError && e.message === 'Unknown cancellation reason'
    );

    for (const bad of [0, -1, 1.5, 'abc', {}]) {
        await assert.rejects(
            resolveCancelReasonId(bad, find, makeError),
            (e) => e instanceof TestValidationError && e.message === 'Invalid cancellation reason'
        );
    }

    console.log('cancelReason.test.js: all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
