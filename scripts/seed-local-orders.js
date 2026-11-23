/**
 * Local development orders: a realistic spread of bookings across every stage of
 * the order lifecycle for the fixture shop, so the shop/driver app, customer app
 * and admin panel can be designed and tested against real-shaped data.
 *
 *   NODE_ENV=development npm run db:seed:local-orders            # create (idempotent)
 *   NODE_ENV=development npm run db:seed:local-orders -- --reset # remove seeded orders, re-create
 *   NODE_ENV=development npm run db:seed:local-orders -- --remove
 *
 * Requires db:seed:local-fixtures (zone, shop@justdrycleans.test). Orders belong to
 * three dedicated seed customers (seed.*@justdrycleans.test, RFC 2606 — never mailed),
 * so they never mix with the main fixture customer's own test orders and can be
 * removed as a set.
 *
 * Shape: each order's rows mirror what the real flows write at that stage (booking,
 * history per status, customer-selected services, agent-priced lines after the
 * invoice, billing, pickup/delivery proof, tips) with the current commercial rates.
 *
 * Deliberately inert: no Stripe ids, no auto-charge scheduled, no notifications,
 * no sockets — card orders show as card orders but nothing can charge them.
 * "New" offers stay acceptable for the 30-minute accept window, as in production;
 * re-run with --reset to refresh them.
 *
 * Guards: NODE_ENV must be "development" and the database host local.
 */
'use strict';

const { assertLocalDatabase } = require('./provision-local-admin');

const SHOP_EMAIL = 'shop@justdrycleans.test';
const SEED_EMAIL_DOMAIN = '@justdrycleans.test';
const SEED_EMAIL_PREFIX = 'seed.';
const TIME_ZONE = 'Europe/London';

// Inside the fixture shop's coverage square (see seed-local-fixtures.js).
const CUSTOMERS = [
  {
    firstName: 'Amelia', lastName: 'Clarke', email: 'seed.amelia@justdrycleans.test', phoneNum: '7400123501',
    address: { title: 'Home', streetAddress: '12 Lamb\'s Conduit Street, London, WC1N 3LE', district: 'Holborn', postalcode: 'WC1N 3LE', lat: '51.5222', lng: '-0.1185' },
  },
  {
    firstName: 'Oliver', lastName: 'Bennett', email: 'seed.oliver@justdrycleans.test', phoneNum: '7400123502',
    address: { title: 'Home', streetAddress: '48 Kennington Road, London, SE1 7BL', district: 'Lambeth', postalcode: 'SE1 7BL', lat: '51.4985', lng: '-0.1124' },
  },
  {
    firstName: 'Priya', lastName: 'Shah', email: 'seed.priya@justdrycleans.test', phoneNum: '7400123503',
    address: { title: 'Office', streetAddress: '95 Borough High Street, London, SE1 1NL', district: 'Southwark', postalcode: 'SE1 1NL', lat: '51.5021', lng: '-0.0920' },
  },
];

// Statuses (bookingStatuses): the lifecycle each order walks through to reach its stage.
const PATH = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17];
const ST = {
  NEW: 1, AWAITING: 3, OUT_FOR_PICKUP: 4, AT_PICKUP: 5, IN_TRANSIT: 7, AT_SHOP: 8,
  SERVICES_ADDED: 9, INVOICED: 10, PROCESSING: 11, READY: 12, OUT_FOR_DELIVERY: 13,
  AT_DELIVERY: 14, DELIVERY_FAILED: 15, DELIVERED: 16, COMPLETED: 17, ON_HOLD: 18, CANCELLED: 19,
};

/**
 * The spread. day: collection day relative to today (shop time); slot: collection hour,
 * inside the fixture shop's opening hours (09:00-18:00) as real bookings must be.
 * Services: 1 Wash & Fold, 2 Wash & Iron, 3 Dry Clean (customer's declared choice).
 */
const ORDERS = [
  { status: ST.NEW, c: 0, day: 0, slot: 16, services: [3], pay: 'card' },
  { status: ST.NEW, c: 1, day: 1, slot: 9, services: [1, 3], pay: 'cash' },
  { status: ST.NEW, c: 2, day: 1, slot: 16, services: [2], pay: 'card', note: 'Ring the bell twice please' },
  { status: ST.AWAITING, c: 0, day: 0, slot: 17, services: [3], pay: 'card' },
  { status: ST.AWAITING, c: 1, day: 0, slot: 16, services: [1], pay: 'cash' },
  { status: ST.AWAITING, c: 2, day: 1, slot: 9, services: [2, 3], pay: 'card' },
  { status: ST.AWAITING, c: 0, day: 2, slot: 11, services: [3], pay: 'card' },
  { status: ST.OUT_FOR_PICKUP, c: 1, day: 0, slot: 15, services: [3], pay: 'card', driver: 'manager' },
  { status: ST.AT_PICKUP, c: 2, day: 0, slot: 14, services: [1], pay: 'cash' },
  { status: ST.IN_TRANSIT, c: 0, day: 0, slot: 12, services: [3], pay: 'card', items: 6, bags: 2 },
  { status: ST.AT_SHOP, c: 1, day: 0, slot: 10, services: [3], pay: 'card', items: 4, bags: 1 },
  { status: ST.AT_SHOP, c: 2, day: -1, slot: 16, services: [2, 3], pay: 'cash', items: 9, bags: 2 },
  { status: ST.INVOICED, c: 0, day: -1, slot: 9, services: [3], pay: 'card', items: 3, bags: 1, lines: [[1, 2], [3, 1]] },
  { status: ST.PROCESSING, c: 1, day: -1, slot: 13, services: [3], pay: 'card', items: 5, bags: 1, lines: [[3, 2], [5, 1], [6, 2]] },
  { status: ST.PROCESSING, c: 2, day: -2, slot: 11, services: [3], pay: 'cash', items: 2, bags: 1, lines: [[10, 2]] },
  { status: ST.READY, c: 0, day: -2, slot: 15, services: [3], pay: 'card', items: 4, bags: 1, lines: [[6, 3], [1, 1]], deliveryDay: 0 },
  { status: ST.OUT_FOR_DELIVERY, c: 1, day: -2, slot: 9, services: [3], pay: 'card', items: 3, bags: 1, lines: [[5, 2], [1, 1]], deliveryDay: 0, driver: 'manager' },
  { status: ST.AT_DELIVERY, c: 2, day: -3, slot: 10, services: [3], pay: 'cash', items: 2, bags: 1, lines: [[3, 2]], deliveryDay: 0 },
  { status: ST.DELIVERY_FAILED, c: 0, day: -3, slot: 12, services: [3], pay: 'card', items: 3, bags: 1, lines: [[1, 3]], deliveryDay: 0 },
  { status: ST.ON_HOLD, c: 1, day: -1, slot: 15, services: [3], pay: 'card', items: 2, bags: 1, lines: [[11, 1]], onHold: 'Stain on the jacket needs your approval before treatment.' },
  { status: ST.COMPLETED, c: 2, day: -5, slot: 10, services: [3], pay: 'card', items: 4, bags: 1, lines: [[1, 2], [6, 2]], deliveryDay: -3 },
  { status: ST.COMPLETED, c: 0, day: -6, slot: 14, services: [3], pay: 'cash', items: 2, bags: 1, lines: [[2, 2]], deliveryDay: -4 },
  { status: ST.CANCELLED, c: 1, day: 1, slot: 12, services: [1], pay: 'card', cancelReason: 'Plans changed — no longer needed.' },
];

function readInput(env = process.env, argv = process.argv.slice(2)) {
  if (env.NODE_ENV !== 'development') {
    throw new Error('Refusing to seed orders: NODE_ENV must be exactly "development".');
  }
  return { reset: argv.includes('--reset'), removeOnly: argv.includes('--remove') };
}

const money = (n) => Math.round(n * 100) / 100;

/** Statuses an order passed through to reach `status` (off-path stages branch late). */
function historyFor(status) {
  if (status === ST.CANCELLED) return [1, 2, 3, 19];
  if (status === ST.ON_HOLD) return [...PATH.slice(0, PATH.indexOf(ST.SERVICES_ADDED) + 1), 18];
  if (status === ST.DELIVERY_FAILED) return [...PATH.slice(0, PATH.indexOf(ST.AT_DELIVERY) + 1), 15];
  return PATH.slice(0, PATH.indexOf(status) + 1);
}

async function seedLocalOrders({ db, moment, bcrypt, crypto, generateOrderTrackId, ensureCustomerDeclaredSnapshot, acceptWindowMinutes = 30, env = process.env, argv, log = console.log }) {
  const { reset, removeOnly } = readInput(env, argv);
  assertLocalDatabase(db.sequelize);
  const { Op } = db.Sequelize;

  const shopUser = await db.users.findOne({ where: { email: SHOP_EMAIL } });
  if (!shopUser) throw new Error(`${SHOP_EMAIL} missing — run db:seed:local-fixtures first.`);
  const shopAddress = await db.addressDb.findOne({ where: { userId: shopUser.id, addressType: 'LaundaryShopAddress' } });
  const zone = shopAddress && (await db.zone.findByPk(shopAddress.zoneId));
  if (!zone) throw new Error('Fixture shop has no zone — run db:seed:local-fixtures first.');
  const manager = await db.users.findOne({ where: { employeeOff: shopUser.id, roleId: 8 } });

  const seedCustomerIds = (await db.users.findAll({
    where: { email: { [Op.like]: `${SEED_EMAIL_PREFIX}%${SEED_EMAIL_DOMAIN}` }, userTypeId: 2 },
    attributes: ['id'],
    paranoid: false,
  })).map((u) => u.id);

  if (reset || removeOnly) {
    const removed = await removeSeededOrders(db, seedCustomerIds);
    log(`[local-orders] removed ${removed} seeded order(s)`);
    if (removeOnly) return { created: 0, removed };
  } else if (seedCustomerIds.length) {
    const existing = await db.booking.count({ where: { customerId: seedCustomerIds } });
    if (existing) {
      log(`[local-orders] ${existing} seeded order(s) already exist — use --reset to re-create.`);
      return { created: 0, removed: 0 };
    }
  }

  // Priced catalogue lines (Dry Clean) used for agent-added invoice lines.
  const subs = await db.subCategories.findAll({ where: { status: true }, attributes: ['id', 'price', 'categoryId'], raw: true });
  const subById = new Map(subs.map((s) => [s.id, s]));
  const dryClean = await db.service.findOne({ where: { name: 'Dry Clean' }, attributes: ['id'] });
  const serviceIds = new Set((await db.service.findAll({ attributes: ['id'], raw: true })).map((s) => s.id));

  // Orders are in the zone's currency (every zone has one); never a hard-coded code.
  const currencyUnit = await db.units.findByPk(zone.currencyUnitId);
  const currencyCode = currencyUnit?.name ? String(currencyUnit.name).trim().toUpperCase() : '';
  if (!currencyCode) throw new Error(`Zone ${zone.id} has no currency unit with an ISO code; fix the zone first.`);
  const zoneMinimum = Number(zone.zoneMinimumAmount) || 0;
  const serviceCharge = Number(zone.serviceCharge) || 0;
  const agentPercent = Number(zone.agentCommissionPercent) || 80;
  const platformPercent = Number(zone.zoneAdminComission) || 100 - agentPercent;
  const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const now = moment.tz(TIME_ZONE);
  const created = [];

  await db.sequelize.transaction(async (transaction) => {
    // Seed customers + their pickup address (sign-in disabled: random password hash).
    const customers = [];
    for (const c of CUSTOMERS) {
      const [user] = await db.users.findOrCreate({
        where: { email: c.email },
        defaults: {
          firstName: c.firstName, lastName: c.lastName, phoneNum: c.phoneNum, countryCode: '+44',
          password: unusableHash, userTypeId: 2, status: true, verifiedAt: new Date(),
          countryId: shopAddress.countryId, cityId: shopAddress.cityId,
        },
        transaction,
      });
      const [address] = await db.addressDb.findOrCreate({
        where: { userId: user.id, addressType: 'pickUp' },
        defaults: {
          ...c.address, province: 'London', status: true, isDefault: true, radius: 10,
          cityId: shopAddress.cityId, countryId: shopAddress.countryId, zoneId: zone.id,
        },
        transaction,
      });
      customers.push({ user, address });
    }

    for (const spec of ORDERS) {
      const { user, address } = customers[spec.c];
      const status = spec.status;
      const accepted = status !== ST.NEW;
      const pickedUp = status >= ST.IN_TRANSIT && status !== ST.CANCELLED;
      const invoiced = !!spec.lines;
      const delivered = status === ST.DELIVERED || status === ST.COMPLETED;
      const outForDelivery = [ST.OUT_FOR_DELIVERY, ST.AT_DELIVERY, ST.DELIVERY_FAILED].includes(status) || delivered;
      const driverId = spec.driver === 'manager' && manager ? manager.id : shopUser.id;

      const collection = now.clone().startOf('day').add(spec.day, 'days');
      const delivery = now.clone().startOf('day').add(spec.deliveryDay ?? spec.day + 2, 'days');
      // New offers are acceptable for BOOKING_ACCEPT_WINDOW_MINUTES after they appear:
      // place them just now (re-run with --reset to refresh them).
      const placedAt = status === ST.NEW
        ? now.clone().subtract(spec.c + 1, 'minutes')
        : collection.clone().subtract(1, 'day').hour(18);

      const lines = (spec.lines || []).map(([subId, items]) => {
        const sub = subById.get(subId);
        if (!sub) throw new Error(`subCategory ${subId} missing — run db:seed first.`);
        return { sub, items };
      });
      const laundry = money(lines.reduce((t, l) => t + Number(l.sub.price) * l.items, 0));
      const effectiveLaundry = Math.max(laundry, zoneMinimum);
      const total = money(effectiveLaundry + serviceCharge);
      const upfront = zoneMinimum + serviceCharge; // paid at booking
      const balance = invoiced ? money(total - upfront) : 0;
      const balancePaid = delivered || (spec.pay === 'card' && invoiced && status >= ST.PROCESSING && status !== ST.ON_HOLD);
      const ts = (m) => m.clone().toDate();

      const booking = await db.booking.create({
        orderTrackId: 'pending',
        collectionDate: collection.format('YYYY-MM-DD'),
        collectionTimeFrom: `${String(spec.slot).padStart(2, '0')}:00:00`,
        collectionTimeTo: `${String(spec.slot + 1).padStart(2, '0')}:00:00`,
        deliveryDate: delivery.format('YYYY-MM-DD'),
        deliveryTimeFrom: '07:00:00',
        deliveryTimeTo: '08:00:00',
        driverInstructionOptions: 'Collect from me in person',
        driverInstructionOptions1: 'Deliver to me in person',
        driverInstruction: spec.note || '',
        // Same format booking creation writes (getOrderExpireTime): shop-time HH:mm:ss.
        orderExpireTime: placedAt.clone().add(acceptWindowMinutes, 'minutes').format('HH:mm:ss'),
        paymentConfirmed: true,
        partialPayment: spec.pay !== 'cash', // as createBooking: cash prepays nothing
        paymentType: spec.pay,
        balanceCollectedVia: balancePaid ? spec.pay : null,
        totalItems: pickedUp ? spec.items || 0 : 0,
        totalBags: pickedUp ? spec.bags || 0 : 0,
        noOfBags: pickedUp ? spec.bags || 0 : 0,
        orderAmount: invoiced ? total : 0,
        subTotal: invoiced ? total : upfront,
        frequency: 'Just Once',
        maxPickupAttempts: 3,
        deliveryAttemptCount: status === ST.DELIVERY_FAILED ? 1 : 0,
        onHoldReason: spec.onHold ? 'Other' : null,
        OnHoldOtherReason: spec.onHold || null,
        policySnapshot: { noShow: null, takenAt: ts(placedAt), reschedule: null, cancellation: null },
        zoneId: zone.id,
        agentBroadcastHeld: false,
        agentVisibleAt: ts(placedAt),
        preferredShopBroadcastDone: true,
        operationalTimeZone: TIME_ZONE,
        customerLocalTimeZone: TIME_ZONE,
        invoiceStatus: invoiced ? 'finalized' : 'none',
        invoiceFinalizedAt: invoiced ? ts(collection.clone().hour(spec.slot + 3)) : null,
        paymentDeliveryGate: 'open',
        autoChargeStatus: 'none', // seeded orders are never charged
        pickupCompletedByUserId: pickedUp ? driverId : null,
        pickupCompletedAt: pickedUp ? ts(collection.clone().hour(spec.slot)) : null,
        deliveryCompletedByUserId: delivered ? driverId : null,
        deliveryCompletedAt: delivered ? ts(delivery.clone().hour(7).minute(30)) : null,
        appliedZoneMinimum: zoneMinimum,
        appliedServiceCharge: serviceCharge,
        appliedAgentCommissionPercent: agentPercent,
        appliedPlatformCommissionPercent: platformPercent,
        rateSnapshotLockedAt: accepted ? ts(placedAt) : null,
        rateSnapshotSource: accepted ? 'accepted' : null,
        pickupAddresId: address.id,
        dropOffAddressId: address.id,
        laundryShopId: accepted && status !== ST.CANCELLED ? shopAddress.id : null,
        bookingStatusId: status,
        customerId: user.id,
        driverId: accepted && status !== ST.CANCELLED ? driverId : null,
        deliveryDriverId: outForDelivery ? driverId : null,
        createdAt: ts(placedAt),
      }, { transaction });
      await booking.update({ orderTrackId: generateOrderTrackId(booking.id) }, { transaction });

      // History: one row per stage reached, spaced through the day.
      let at = placedAt.clone();
      for (const s of historyFor(status)) {
        at = at.clone().add(s === 1 ? 0 : 7, 'minutes');
        await db.bookingHistory.create({
          date: at.format('YYYY-MM-DD'), time: at.format('HH:mm:ss'),
          bookingId: booking.id, bookingStatusId: s,
          actorType: s === 1 || s === 19 ? 'customer' : 'agent',
          actorUserId: s === 1 || s === 19 ? user.id : driverId,
        }, { transaction });
      }

      // What the customer chose when booking.
      for (const serviceId of spec.services) {
        if (!serviceIds.has(serviceId)) throw new Error(`service ${serviceId} missing — run db:seed first.`);
        await db.customerSelectedService.create({
          date: placedAt.format('YYYY-MM-DD'), time: placedAt.format('HH:mm:ss'), bookingId: booking.id, serviceId,
        }, { transaction });
      }
      // Accepting freezes the customer's choices (as orderManagementService does).
      if (accepted) await ensureCustomerDeclaredSnapshot(booking.id, { transaction });

      // What the shop priced on the invoice.
      for (const { sub, items } of lines) {
        await db.customerSelectedService.create({
          date: collection.format('YYYY-MM-DD'), time: '13:00:00', bookingId: booking.id,
          serviceId: dryClean.id, categoryId: sub.categoryId, subCategoryId: sub.id,
          categoryPrice: Number(sub.price), items, status: true,
        }, { transaction });
      }

      await db.billingDetails.create({
        bookingId: booking.id,
        upfrontAmount: zoneMinimum,
        serviceCharge,
        categoryCharge: laundry,
        total: invoiced ? total : upfront,
        agentEarning: invoiced ? money((effectiveLaundry * agentPercent) / 100) : null,
        zoneAdminCommission: invoiced ? money((effectiveLaundry * platformPercent) / 100) : null,
        paymentStatus: balancePaid ? 'Paid' : 'Pending', // as createBooking until settled
      }, { transaction });
      await db.tip.create({ bookingId: booking.id, source: 'booking' }, { transaction });

      // Arrival attempts, as noShowEnforcementService records them: "arrived" opens
      // one (the at-pickup / at-door screens need it), completion or failure closes it.
      const attempt = (attemptType, at, outcome) => db.bookingAttempt.create({
        bookingId: booking.id, attemptType, attemptNumber: 1, driverId,
        status: outcome, arrivedAt: ts(at),
        completedAt: outcome === 'completed' ? ts(at.clone().add(12, 'minutes')) : null,
        failedAt: outcome === 'failed' ? ts(at.clone().add(15, 'minutes')) : null,
        failureReasonNote: outcome === 'failed' ? 'Customer not available' : null,
        feeAmount: 0, feeCurrency: currencyCode,
        feeWaived: outcome === 'completed',
        feeWaiveReason: outcome === 'completed' ? 'Successful completion' : null,
      }, { transaction });
      const pickupAt = collection.clone().hour(spec.slot);
      if (status === ST.AT_PICKUP) await attempt('pickup', pickupAt, 'arrived');
      if (pickedUp) await attempt('pickup', pickupAt, 'completed');
      const doorAt = delivery.clone().hour(7).minute(10);
      if (status === ST.AT_DELIVERY) await attempt('delivery', doorAt, 'arrived');
      if (status === ST.DELIVERY_FAILED) await attempt('delivery', doorAt, 'failed');
      if (delivered) await attempt('delivery', doorAt, 'completed');

      if (pickedUp) {
        await db.proofOfDeliveries.create({
          bookingId: booking.id, userId: driverId, deliveryType: 'pickUp',
          noOfItems: spec.items || 0, noOfBags: spec.bags || 0,
        }, { transaction });
      }
      if (delivered) {
        await db.proofOfDeliveries.create({ bookingId: booking.id, userId: driverId, deliveryType: 'dropOff' }, { transaction });
      }
      if (status === ST.CANCELLED) {
        await db.cancelBooking.create({
          bookingId: booking.id, userId: user.id, reasonText: spec.cancelReason,
          feeAmount: 0, feeCurrency: currencyCode, feeStatus: 'none',
        }, { transaction });
      }
      created.push(`${booking.orderTrackId.padEnd(10)} ${String(status).padStart(2)}  ${spec.pay.padEnd(4)}  ${user.firstName}`);
    }
  });

  log(`[local-orders] created ${created.length} orders for ${SHOP_EMAIL}:\n  ` + created.join('\n  '));
  return { created: created.length, removed: 0 };
}

/** Removes seeded customers' orders and every row they own (children first). */
async function removeSeededOrders(db, seedCustomerIds) {
  if (!seedCustomerIds.length) return 0;
  const bookings = await db.booking.findAll({ where: { customerId: seedCustomerIds }, attributes: ['id'], paranoid: false });
  const ids = bookings.map((b) => b.id);
  if (!ids.length) return 0;
  await db.sequelize.transaction(async (transaction) => {
    const children = [
      db.bookingHistory, db.customerSelectedService, db.billingDetails, db.tip, db.proofOfDeliveries,
      db.cancelBooking, db.bookingAttempt, db.wallet, db.invoicePaymentAttempt, db.bookingRefund,
      db.OnHoldConfirmation, db.bookingPreference, db.servicePreferences,
      db.customerOriginalPreferenceSnapshot, db.customerOriginalServiceSnapshot,
    ].filter(Boolean);
    for (const model of children) {
      await model.destroy({ where: { bookingId: ids }, force: true, transaction });
    }
    await db.booking.destroy({ where: { id: ids }, force: true, transaction });
  });
  return ids.length;
}

async function main() {
  require('dotenv').config();
  readInput(process.env); // fail fast before loading models
  const db = require('../models');
  try {
    await seedLocalOrders({
      db,
      moment: require('moment-timezone'),
      bcrypt: require('bcryptjs'),
      crypto: require('crypto'),
      generateOrderTrackId: require('../utils/orderTrackId').generateOrderTrackId,
      acceptWindowMinutes: require('../utils/bookingTimeZone').BOOKING_ACCEPT_WINDOW_MINUTES,
      ensureCustomerDeclaredSnapshot:
        require('../services/Agent/customerDeclaredServicesService').ensureCustomerDeclaredSnapshot,
    });
  } finally {
    await db.sequelize.close();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}

module.exports = { readInput, historyFor, seedLocalOrders, removeSeededOrders, ORDERS, CUSTOMERS };
