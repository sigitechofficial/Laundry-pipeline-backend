'use strict';

/**
 * Socket rooms are per user id and staff join their own room, so reaching
 * every device of a shop means the owner plus each staff member.
 */
async function shopDeviceUserIds(shopUserId) {
  const { users } = require('../models');
  const staff = await users.findAll({
    where: { employeeOff: shopUserId },
    attributes: ['id'],
  });
  return [Number(shopUserId), ...staff.map((s) => Number(s.id))];
}

/** Fire-and-forget: sendEvent waits up to 4s per ack, which must not block a request. */
function emitToShopDevices(shopUserId, type, data) {
  const { sendEvent } = require('../socket_io');
  shopDeviceUserIds(shopUserId)
    .then((ids) => Promise.allSettled(ids.map((id) => sendEvent(id, { type, data }))))
    .catch((err) => console.error(`[${type}] notify shop devices failed`, err?.message || err));
}

module.exports = { shopDeviceUserIds, emitToShopDevices };
