"use strict";

const assert = require("assert");
const {
    resolveCommercialTerms,
    toCommercialTermsPayload,
    isBookingAccepted,
    liveZoneTerms,
} = require("./bookingRateSnapshot");

function runTests() {
    assert.strictEqual(isBookingAccepted({ laundryShopId: null }), false);
    assert.strictEqual(isBookingAccepted({ laundryShopId: 12 }), true);

    const liveZone = {
        zoneMinimumAmount: "15.00",
        serviceCharge: "5.00",
        agentCommissionPercent: 80,
        zoneAdminComission: 20,
    };

    const unlocked = resolveCommercialTerms(
        { laundryShopId: null, rateSnapshotLockedAt: null },
        liveZone
    );
    assert.strictEqual(unlocked.locked, false);
    assert.strictEqual(unlocked.source, "live");
    assert.strictEqual(unlocked.zoneMinimumAmount, 15);
    assert.strictEqual(unlocked.agentCommissionPercent, 80);

    const locked = resolveCommercialTerms(
        {
            laundryShopId: 9,
            rateSnapshotLockedAt: "2026-09-02T10:00:00.000Z",
            rateSnapshotSource: "accepted",
            appliedZoneMinimum: "12.00",
            appliedServiceCharge: "4.00",
            appliedAgentCommissionPercent: 70,
            appliedPlatformCommissionPercent: 30,
        },
        liveZone
    );
    assert.strictEqual(locked.locked, true);
    assert.strictEqual(locked.zoneMinimumAmount, 12);
    assert.strictEqual(locked.serviceCharge, 4);
    assert.strictEqual(locked.agentCommissionPercent, 70);
    assert.strictEqual(locked.platformCommissionPercent, 30);
    assert.strictEqual(locked.live.agentCommissionPercent, 80);

    const payload = toCommercialTermsPayload(locked);
    assert.strictEqual(payload.differsFromLiveZone, true);
    assert.strictEqual(payload.liveZone.zoneMinimumAmount, 15);

    const sameAsLive = toCommercialTermsPayload(
        resolveCommercialTerms(
            {
                rateSnapshotLockedAt: "2026-09-02T10:00:00.000Z",
                rateSnapshotSource: "accepted",
                appliedZoneMinimum: 15,
                appliedServiceCharge: 5,
                appliedAgentCommissionPercent: 80,
                appliedPlatformCommissionPercent: 20,
            },
            liveZone
        )
    );
    assert.strictEqual(sameAsLive.differsFromLiveZone, false);

    const fromPlatformOnly = liveZoneTerms({
        zoneMinimumAmount: 10,
        serviceCharge: 2,
        zoneAdminComission: 25,
    });
    assert.strictEqual(fromPlatformOnly.agentCommissionPercent, 75);
    assert.strictEqual(fromPlatformOnly.platformCommissionPercent, 25);

    console.log("bookingRateSnapshot.test.js: all assertions passed");
}

runTests();
