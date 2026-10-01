'use strict';

/**
 * Admin "Shop Live Ops" board — same day/slot/pickup/drop rules as the agent app
 * (Today/Tomorrow/Orders), sorted shop-nearest (admin has no agent GPS).
 *
 * Read-only ops view for support: capacity + what is on the shop board right now.
 */
const moment = require('moment');
const { Op, literal } = require('sequelize');
const {
  booking,
  bookingStatus,
  addressDb,
  users,
  countries,
  cities,
  bussinessInformation,
} = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { getShopAcceptCapacityStatus } = require('../../utils/shopAcceptCapacity');
const {
  latLngOf,
  haversineKm,
  rankByNearestRoute,
  sortLaneByRoute,
} = require('../../utils/shopLiveOpsRouteRank');

const PICKUP_STATUSES = [3, 4, 5, 6, 7];
const INVOICE_STATUSES = [8, 9];
const PROCESSING_STATUSES = [10, 11];
const POST_FACILITY_STATUSES = [12, 13, 14, 15, 16];
const POST_PICKUP_STATUSES = [
  ...INVOICE_STATUSES,
  ...PROCESSING_STATUSES,
  ...POST_FACILITY_STATUSES,
];
const ALL_ACTIVE_STATUSES = [...PICKUP_STATUSES, ...POST_PICKUP_STATUSES];

const SLOT_STARTS = [
  '07:00',
  '08:00',
  '09:00',
  '10:00',
  '11:00',
  '12:00',
  '13:00',
  '14:00',
  '15:00',
  '16:00',
  '17:00',
  '18:00',
];

const BOOKING_ATTRS = [
  'id',
  'orderTrackId',
  'collectionTimeFrom',
  'collectionTimeTo',
  'collectionDate',
  'deliveryTimeFrom',
  'deliveryTimeTo',
  'deliveryDate',
  'driverInstructionOptions',
  'driverInstructionOptions1',
  'driverInstruction',
  'bookingStatusId',
  'totalItems',
  'totalBags',
  'sameBagForAllServices',
  'noOfBags',
  'pickupAttemptCount',
  'pickupRescheduleRequired',
  'deliveryAttemptCount',
  'driverId',
  'deliveryDriverId',
  'createdAt',
];

const dayTabWhere = (shopAddressId, dayStart, dayEnd) => ({
  laundryShopId: shopAddressId,
  [Op.or]: [
    {
      bookingStatusId: { [Op.in]: PICKUP_STATUSES },
      collectionDate: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
    },
    {
      bookingStatusId: { [Op.in]: POST_PICKUP_STATUSES },
      deliveryDate: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
    },
  ],
});

const relevantDateOrder = [
  [
    literal(
      `CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionDate ELSE deliveryDate END IS NULL`
    ),
    'ASC',
  ],
  [
    literal(
      `CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionDate ELSE deliveryDate END`
    ),
    'ASC',
  ],
  [
    literal(
      `CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionTimeFrom ELSE deliveryTimeFrom END IS NULL`
    ),
    'ASC',
  ],
  [
    literal(
      `CASE WHEN bookingStatusId IN (3,4,5,6,7) THEN collectionTimeFrom ELSE deliveryTimeFrom END`
    ),
    'ASC',
  ],
];

function nextHour(hhmm) {
  const [h, m] = String(hhmm).split(':').map((n) => Number(n));
  const next = (Number.isFinite(h) ? h : 0) + 1;
  return `${String(next).padStart(2, '0')}:${String(Number.isFinite(m) ? m : 0).padStart(2, '0')}`;
}

function slotWhere(shopAddressId, slotFrom, slotTo, dayStart, dayEnd) {
  const pickupBranch = {
    bookingStatusId: { [Op.in]: PICKUP_STATUSES },
    collectionTimeFrom: { [Op.gte]: slotFrom },
    collectionTimeTo: { [Op.lte]: slotTo },
    collectionDate: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
  };
  const deliveryBranch = {
    bookingStatusId: { [Op.in]: POST_PICKUP_STATUSES },
    deliveryDate: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
    deliveryTimeFrom: { [Op.gte]: slotFrom },
    deliveryTimeTo: { [Op.lte]: slotTo },
  };
  return {
    laundryShopId: shopAddressId,
    bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES },
    [Op.or]: [pickupBranch, deliveryBranch],
  };
}

function makeIncludes() {
  return [
    { model: bookingStatus, attributes: ['id', 'title', 'description'] },
    {
      model: addressDb,
      as: 'laundryShop',
      required: false,
      attributes: [
        'streetAddress',
        'district',
        'province',
        'addressType',
        'lat',
        'lng',
        'postalcode',
      ],
      include: [
        { model: countries, attributes: ['id', 'name', 'shortName'] },
        { model: cities, attributes: ['id', 'name'] },
      ],
    },
    {
      model: addressDb,
      as: 'pickupAddress',
      required: false,
      attributes: [
        'streetAddress',
        'district',
        'province',
        'addressType',
        'lat',
        'lng',
        'postalcode',
      ],
      include: [
        { model: countries, attributes: ['id', 'name', 'shortName'] },
        { model: cities, attributes: ['id', 'name'] },
      ],
    },
    {
      model: addressDb,
      as: 'dropOffAddress',
      required: false,
      attributes: [
        'streetAddress',
        'district',
        'province',
        'addressType',
        'lat',
        'lng',
        'postalcode',
      ],
      include: [
        { model: countries, attributes: ['id', 'name', 'shortName'] },
        { model: cities, attributes: ['id', 'name'] },
      ],
    },
    {
      model: users,
      as: 'customer',
      attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum'],
    },
    {
      model: users,
      as: 'driver',
      required: false,
      attributes: ['id', 'firstName', 'lastName', 'image'],
    },
    {
      model: users,
      as: 'deliveryDriver',
      required: false,
      attributes: ['id', 'firstName', 'lastName', 'image'],
    },
  ];
}

function decorateBooking(row) {
  const plain = row.toJSON ? row.toJSON() : { ...row };
  const isPickupFailed =
    plain.bookingStatusId === 3 && Boolean(plain.pickupRescheduleRequired);
  const isDeliveryFailed = plain.bookingStatusId === 15;
  const failedAttemptType = isDeliveryFailed
    ? 'delivery'
    : isPickupFailed
      ? 'pickup'
      : null;
  plain.displayStatus = isPickupFailed
    ? {
        id: 3,
        title: 'Pickup Failed',
        description: 'A pickup attempt was unsuccessful',
      }
    : plain.bookingStatus || null;
  plain.attemptFlags = {
    hasFailedAttempt: Boolean(failedAttemptType),
    failedAttemptType,
    pickupAttemptCount: Number(plain.pickupAttemptCount) || 0,
    pickupRescheduleRequired: Boolean(plain.pickupRescheduleRequired),
    deliveryAttemptCount: Number(plain.deliveryAttemptCount) || 0,
  };
  return plain;
}

async function resolveShop(shopUserId) {
  const uid = Number(shopUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new ValidationError('shopUserId is required');
  }
  let shopAddress = await addressDb.findOne({
    where: {
      userId: uid,
      addressType: 'LaundaryShopAddress',
    },
    attributes: [
      'id',
      'userId',
      'streetAddress',
      'district',
      'province',
      'lat',
      'lng',
      'zoneId',
    ],
    include: [
      {
        model: users,
        attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum'],
        required: true,
      },
    ],
  });
  if (!shopAddress) {
    // Fallback: same as agent board (first address for userId).
    shopAddress = await addressDb.findOne({
      where: { userId: uid },
      attributes: [
        'id',
        'userId',
        'streetAddress',
        'district',
        'province',
        'lat',
        'lng',
        'zoneId',
      ],
      include: [
        {
          model: users,
          attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum'],
          required: true,
        },
      ],
    });
  }
  if (!shopAddress) {
    throw new NotFoundError('Shop address not found for this shop user');
  }

  const biz = await bussinessInformation.findOne({
    where: { shopAddressId: shopAddress.id },
    attributes: ['id', 'shopName'],
  });
  shopAddress.setDataValue('resolvedShopName', biz?.shopName || null);

  return shopAddress;
}

async function fetchDayBookings(shopAddressId, dayStart, dayEnd) {
  const rows = await booking.findAll({
    where: dayTabWhere(shopAddressId, dayStart, dayEnd),
    order: relevantDateOrder,
    attributes: BOOKING_ATTRS,
    include: makeIncludes(),
  });
  return rows.map(decorateBooking);
}

async function fetchActiveOrders(shopAddressId) {
  const rows = await booking.findAll({
    where: {
      laundryShopId: shopAddressId,
      bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES },
    },
    order: relevantDateOrder,
    attributes: BOOKING_ATTRS,
    include: makeIncludes(),
  });
  return rows.map(decorateBooking);
}

async function fetchSlots(shopAddressId, dayStart, dayEnd, shopOrigin) {
  const slots = await Promise.all(
    SLOT_STARTS.map(async (slotFrom) => {
      const slotTo = nextHour(slotFrom);
      const rows = await booking.findAll({
        where: slotWhere(shopAddressId, slotFrom, slotTo, dayStart, dayEnd),
        attributes: BOOKING_ATTRS,
        include: makeIncludes(),
      });
      const decorated = rows.map(decorateBooking);
      const ranked = rankByNearestRoute(decorated, shopOrigin, (o) => {
        const sid = Number(o.bookingStatusId) || 0;
        return sid <= 7 ? latLngOf(o.pickupAddress) : latLngOf(o.dropOffAddress);
      });
      return {
        slot: `${slotFrom} - ${slotTo}`,
        bookingCount: ranked.length,
        bookings: ranked,
      };
    })
  );
  return slots.filter((s) => s.bookingCount > 0);
}

function splitPickupDrop(dayBookings, dayStart) {
  const day = String(dayStart).slice(0, 10);
  const pickup = dayBookings.filter((o) => {
    const sid = Number(o.bookingStatusId) || -1;
    if (sid < 3 || sid > 7) return false;
    const cd = o.collectionDate ? String(o.collectionDate).slice(0, 10) : '';
    return cd === day;
  });
  const drop = dayBookings.filter((o) => {
    const dd = o.deliveryDate ? String(o.deliveryDate).slice(0, 10) : '';
    return dd === day;
  });
  return { pickup, drop };
}

/**
 * @param {number|string} shopUserId owner users.id
 * @param {{ day?: 'today'|'tomorrow' }} [opts]
 */
async function getShopLiveOps(shopUserId, opts = {}) {
  const shopAddress = await resolveShop(shopUserId);
  const shopAddressId = Number(shopAddress.id);
  const shopOrigin = latLngOf(shopAddress);

  const dayKey = opts.day === 'tomorrow' ? 'tomorrow' : 'today';
  const base = moment().startOf('day');
  const dayMoment = dayKey === 'tomorrow' ? base.clone().add(1, 'day') : base;
  const dayStart = dayMoment.format('YYYY-MM-DD');
  const dayEnd = dayMoment.clone().add(1, 'day').format('YYYY-MM-DD');
  const todayStart = base.format('YYYY-MM-DD');
  const todayEnd = base.clone().add(1, 'day').format('YYYY-MM-DD');
  const tomorrowStart = base.clone().add(1, 'day').format('YYYY-MM-DD');
  const tomorrowEnd = base.clone().add(2, 'day').format('YYYY-MM-DD');

  const [dayBookings, orders, slots, capacity, countToday, countTomorrow, countOrders] =
    await Promise.all([
      fetchDayBookings(shopAddressId, dayStart, dayEnd),
      fetchActiveOrders(shopAddressId),
      fetchSlots(shopAddressId, dayStart, dayEnd, shopOrigin),
      getShopAcceptCapacityStatus(Number(shopUserId)).catch(() => null),
      booking.count({
        where: dayTabWhere(shopAddressId, todayStart, todayEnd),
      }),
      booking.count({
        where: dayTabWhere(shopAddressId, tomorrowStart, tomorrowEnd),
      }),
      booking.count({
        where: {
          laundryShopId: shopAddressId,
          bookingStatusId: { [Op.in]: ALL_ACTIVE_STATUSES },
        },
      }),
    ]);

  const { pickup, drop } = splitPickupDrop(dayBookings, dayStart);
  const pickupSorted = sortLaneByRoute(pickup, shopOrigin, 'pickup');
  const dropSorted = sortLaneByRoute(drop, shopOrigin, 'drop');

  // Day "all" list: keep agent-relevant date order, add distance from shop.
  const allSorted = dayBookings.map((o) => {
    const sid = Number(o.bookingStatusId) || 0;
    const c =
      sid <= 7 ? latLngOf(o.pickupAddress) : latLngOf(o.dropOffAddress);
    return {
      ...o,
      distanceKm:
        shopOrigin && c
          ? Math.round(haversineKm(shopOrigin, c) * 1000) / 1000
          : null,
      stopRank: null,
      legKm: null,
    };
  });

  const bizName = shopAddress.get?.('resolvedShopName') || shopAddress.resolvedShopName;
  // belongsTo(users) without `as` → accessor is model name (`users`) on some Sequelize setups.
  const ownerUser = shopAddress.user || shopAddress.users || null;

  return {
    shop: {
      shopUserId: Number(shopUserId),
      shopAddressId,
      shopName:
        bizName ||
        ownerUser?.firstName ||
        shopAddress.streetAddress ||
        'Shop',
      streetAddress: shopAddress.streetAddress,
      lat: shopAddress.lat,
      lng: shopAddress.lng,
      zoneId: shopAddress.zoneId,
    },
    day: dayKey,
    dayDate: dayStart,
    sortBasis: shopOrigin
      ? 'shop_nearest_route'
      : 'server_date_order_no_shop_coords',
    capacity,
    counts: {
      today: countToday,
      tomorrow: countTomorrow,
      orders: countOrders,
      dayAll: allSorted.length,
      dayPickup: pickupSorted.length,
      dayDrop: dropSorted.length,
    },
    board: {
      all: allSorted,
      pickup: pickupSorted,
      drop: dropSorted,
      slots,
      orders,
    },
  };
}

module.exports = {
  getShopLiveOps,
  PICKUP_STATUSES,
  ALL_ACTIVE_STATUSES,
  dayTabWhere,
};
