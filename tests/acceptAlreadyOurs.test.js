'use strict';

const assert = require('assert');
const { acceptedByThisShop } = require('../services/Agent/agentAcceptOrderService');

(async () => {
  const ours = await acceptedByThisShop(
    { id: 5, laundryShopId: 9, bookingStatusId: 3 },
    9
  );
  assert.strictEqual(ours.alreadyAccepted, true);
  assert.strictEqual(ours.bookingId, 5);
  assert.strictEqual(ours.laundryShopId, 9);

  assert.strictEqual(
    await acceptedByThisShop({ id: 5, laundryShopId: null, bookingStatusId: 1 }, 9),
    null,
    'an open order is not already accepted'
  );
  assert.strictEqual(
    await acceptedByThisShop({ id: 5, laundryShopId: 4, bookingStatusId: 3 }, 9),
    null,
    'another shop owning it is not our repeat accept'
  );
  console.log('acceptAlreadyOurs.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
