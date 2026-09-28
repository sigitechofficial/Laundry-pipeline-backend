'use strict';

const db = require('../../models');

const { users } = db;

const PRINT_JOB_EVENT = 'printJobCreated';

/** Staff sockets join their own user-id room, so the owner and every staff member are notified. */
async function shopDeviceUserIds(shopUserId) {
  const staff = await users.findAll({
    where: { employeeOff: shopUserId },
    attributes: ['id'],
  });
  return [Number(shopUserId), ...staff.map((s) => Number(s.id))];
}

/** Fire-and-forget: sendEvent waits up to 4s per ack, which must not block the admin request. */
function notifyShopDevices(shopUserId, payload) {
  const { sendEvent } = require('../../socket_io');
  shopDeviceUserIds(shopUserId)
    .then((ids) =>
      Promise.allSettled(
        ids.map((id) => sendEvent(id, { type: PRINT_JOB_EVENT, data: payload }))
      )
    )
    .catch((err) => console.error('[printJob] notify shop devices failed', err?.message || err));
}

module.exports = { notifyShopDevices, PRINT_JOB_EVENT };
