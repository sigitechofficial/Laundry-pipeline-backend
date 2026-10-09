'use strict';

/**
 * Push the shop's capacity snapshot (slot capacity + upcoming slot load) to every
 * device for that shop (owner + staff). Used after a marketplace accept and when
 * an accept is refused because the slot is full.
 */

const EVENT = 'shopAcceptCapacity';
const REACHED_EVENT = 'shopAcceptCapReached';

async function shopDeviceUserIds(shopUserId) {
  const { users } = require('../models');
  const staff = await users.findAll({
    where: { employeeOff: shopUserId },
    attributes: ['id'],
  });
  return [Number(shopUserId), ...staff.map((s) => Number(s.id))];
}

/**
 * Fire-and-forget. Does not block accept.
 * @param {number} shopUserId shop owner user id
 * @param {{ capacity?: object, message?: string }} [options]
 */
function notifyShopAcceptCapacity(shopUserId, options = {}) {
  const ownerId = Number(shopUserId);
  if (!Number.isFinite(ownerId) || ownerId <= 0) return;

  (async () => {
    try {
      const { getShopAcceptCapacityStatus } = require('./shopAcceptCapacity');

      const capacity =
        options.capacity || (await getShopAcceptCapacityStatus(ownerId));
      if (!capacity) return;

      // Only use the "reached" event (agent fail toast) on rejected accepts;
      // the message then says which slot is full (shopSlotCapacity.slotFullMessage).
      const type = options.reachedToast ? REACHED_EVENT : EVENT;
      const message = options.message || undefined;

      const { sendEvent } = require('../socket_io');
      const ids = await shopDeviceUserIds(ownerId);
      await Promise.allSettled(
        ids.map((id) =>
          sendEvent(id, {
            type,
            data: {
              capacity,
              ...(message ? { message } : {}),
            },
          })
        )
      );
    } catch (err) {
      console.error(
        '[shopAcceptCapacity] notify failed:',
        err?.message || err
      );
    }
  })();
}

module.exports = {
  notifyShopAcceptCapacity,
  EVENT,
  REACHED_EVENT,
};
