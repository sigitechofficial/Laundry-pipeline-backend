'use strict';

/**
 * Push the shop's rolling accept-capacity snapshot to every device for that shop
 * (owner + staff). Used after marketplace accept so the agent banner updates live.
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
      const {
        capacityReachedMessage,
      } = require('./shopAcceptCapacityWindow');

      const capacity =
        options.capacity || (await getShopAcceptCapacityStatus(ownerId));
      if (!capacity) return;

      const atCap = capacity.enabled === true && capacity.atCapacity === true;
      // Only use the "reached" event (agent fail toast) on rejected accepts.
      const type = options.reachedToast ? REACHED_EVENT : EVENT;
      const message =
        options.message ||
        (options.reachedToast && atCap
          ? capacityReachedMessage(capacity)
          : undefined);

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
