'use strict';

const otpGenerator = require('otp-generator');
const { Op } = require('sequelize');
const db = require('../../models');
const {
  booking,
  recurringPlan,
  customerSelectedService,
  customerSelectedServiceLine,
  customerSelectedServiceAddOn,
  bookingPreference,
  billingDetails,
  tip,
  users,
  addressDb,
  zone,
} = db;
const {
  getOrderExpireTime,
  PREFERRED_SHOP_WINDOW_MINUTES,
} = require('../../utils/bookingTimeZone');
const { getCountryContextFromZoneId } = require('../../utils/countryTimeZone');
const { getAfterHoursOrderExpireTime } = require('../../utils/afterHoursBooking');
const {
  isAnyShopOpenInZone,
  isPlatformOpenNow,
} = require('../../utils/shopWorkingHours');

const RECURRING_INTERVAL_DAYS = {
  'just once': 0,
  weekly: 7,
  'every two weeks': 14,
  'every four weeks': 28,
};

function normalizeFrequencyLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'just once' || raw === 'just once.') return 'Just Once';
  if (raw === 'weekly') return 'Weekly';
  if (raw === 'every two weeks') return 'Every two weeks';
  if (raw === 'every four weeks') return 'Every four weeks';
  return 'Just Once';
}

function getRecurringIntervalDays(value) {
  const key = String(value || '').trim().toLowerCase();
  return RECURRING_INTERVAL_DAYS[key] || 0;
}

function isRecurringFrequency(value) {
  return getRecurringIntervalDays(value) > 0;
}

function shiftDateByDays(input, days) {
  const base = new Date(input);
  if (!Number.isFinite(base.getTime())) return null;
  const out = new Date(base);
  out.setUTCDate(out.getUTCDate() + Number(days || 0));
  return out;
}

function makeOrderTrackSuffix() {
  return otpGenerator.generate(6, {
    lowerCaseAlphabets: false,
    upperCaseAlphabets: false,
    specialChars: false,
  });
}

async function ensurePlanForBooking(bookingId, transaction) {
  const row = await booking.findByPk(bookingId, { transaction });
  if (!row) return null;
  if (!isRecurringFrequency(row.frequency)) return null;
  const runtimeSettings = require('../Admin/runtimeSettingsService');
  const maxFailures = await runtimeSettings.getInteger('recurringMaxFailuresBeforePause');

  if (row.recurringPlanId) {
    return recurringPlan.findByPk(row.recurringPlanId, { transaction });
  }

  const rootSourceBookingId = row.recurringSourceBookingId || row.id;
  let plan = await recurringPlan.findOne({
    where: { sourceBookingId: rootSourceBookingId },
    transaction,
  });

  if (!plan) {
    plan = await recurringPlan.create(
      {
        customerId: row.customerId,
        sourceBookingId: rootSourceBookingId,
        frequency: normalizeFrequencyLabel(row.frequency),
        status: 'active',
        nextRunAt: null,
        lastGeneratedFromBookingId: null,
        lastGeneratedAt: null,
        failureCount: 0,
        maxFailures,
      },
      { transaction }
    );
  }

  await row.update({ recurringPlanId: plan.id }, { transaction });
  return plan;
}

async function cloneServiceRows(sourceBookingId, newBookingId, transaction) {
  const rows = await customerSelectedService.findAll({
    where: { bookingId: sourceBookingId, status: true },
    include: [
      {
        model: customerSelectedServiceLine,
        as: 'serviceLines',
        required: false,
      },
      {
        model: customerSelectedServiceAddOn,
        as: 'addOns',
        required: false,
      },
    ],
    order: [
      ['id', 'ASC'],
      [{ model: customerSelectedServiceLine, as: 'serviceLines' }, 'lineNum', 'ASC'],
      [{ model: customerSelectedServiceAddOn, as: 'addOns' }, 'id', 'ASC'],
    ],
    transaction,
  });

  const oldToNewServiceId = new Map();
  const oldToNewLineId = new Map();
  const now = new Date();

  for (const row of rows) {
    const plain = row.get({ plain: true });
    const created = await customerSelectedService.create(
      {
        bookingId: newBookingId,
        serviceId: plain.serviceId,
        categoryId: plain.categoryId,
        subCategoryId: plain.subCategoryId,
        date: plain.date || now,
        time: plain.time || '00:00:00',
        servicePrice: plain.servicePrice,
        categoryPrice: plain.categoryPrice,
        items: plain.items,
        bags: plain.bags,
        status: true,
        serviceInstruction: plain.serviceInstruction || null,
      },
      { transaction }
    );
    oldToNewServiceId.set(plain.id, created.id);

    for (const line of plain.serviceLines || []) {
      const newLine = await customerSelectedServiceLine.create(
        {
          customerSelectedServiceId: created.id,
          lineNum: line.lineNum || 1,
          items: line.items || 1,
          createdAt: now,
          updatedAt: now,
        },
        { transaction }
      );
      oldToNewLineId.set(line.id, newLine.id);
    }
  }

  for (const row of rows) {
    const plain = row.get({ plain: true });
    const mappedServiceId = oldToNewServiceId.get(plain.id);
    if (!mappedServiceId) continue;

    for (const addOn of plain.addOns || []) {
      await customerSelectedServiceAddOn.create(
        {
          customerSelectedServiceId: mappedServiceId,
          customerSelectedServiceLineId: addOn.customerSelectedServiceLineId
            ? oldToNewLineId.get(addOn.customerSelectedServiceLineId) || null
            : null,
          addOnServiceId: addOn.addOnServiceId,
          price: addOn.price || 0,
          items: addOn.items || 1,
          instructions: addOn.instructions || null,
          createdAt: now,
          updatedAt: now,
        },
        { transaction }
      );
    }
  }

  const oldPreferences = await bookingPreference.findAll({
    where: { bookingId: sourceBookingId },
    order: [['id', 'ASC']],
    transaction,
  });
  if (oldPreferences.length) {
    const prefRows = oldPreferences.map((p) => {
      const plain = p.get({ plain: true });
      return {
        bookingId: newBookingId,
        customerSelectedServiceId: plain.customerSelectedServiceId
          ? oldToNewServiceId.get(plain.customerSelectedServiceId) || null
          : null,
        preferenceTypeId: plain.preferenceTypeId,
        preferenceValueId: plain.preferenceValueId,
        parentPreferenceValueId: plain.parentPreferenceValueId || null,
        preferenceInstruction: plain.preferenceInstruction || null,
        createdAt: now,
        updatedAt: now,
      };
    });
    await bookingPreference.bulkCreate(prefRows, { transaction });
  }
}

async function applyAssignmentVisibility({
  bookingId,
  customerId,
  zoneId,
  servicesPayload,
  collectionDate,
  collectionTimeFrom,
  collectionTimeTo,
  deliveryDate,
  deliveryTimeFrom,
  deliveryTimeTo,
  fallbackTimeZone,
}) {
  const runtimeSettings = require('../Admin/runtimeSettingsService');
  const customerOrderService = require('./customerOrderService');
  const resolvedCountry = await getCountryContextFromZoneId(zoneId);
  const resolvedTz = fallbackTimeZone || resolvedCountry?.ianaTimeZone || 'Europe/London';

  const platformOpen = await isPlatformOpenNow(resolvedCountry.countryId, resolvedTz);
  const zoneOpen = platformOpen && (await isAnyShopOpenInZone(zoneId, resolvedTz));

  if (!platformOpen) {
    const afterHoursExpiry = await getAfterHoursOrderExpireTime(
      resolvedCountry.countryId,
      resolvedTz,
      null,
      new Date()
    );
    await booking.update(
      {
        agentBroadcastHeld: true,
        agentVisibleAt: null,
        orderExpireTime: afterHoursExpiry.orderExpireTime,
        placedOutsidePlatformHours: true,
        preferredShopAgentId: null,
        preferredShopExpiresAt: null,
        preferredShopBroadcastDone: false,
      },
      { where: { id: bookingId } }
    );
    return { agentBroadcastHeld: true, notifiedCount: 0, mode: 'held_after_hours' };
  }

  if (!zoneOpen) {
    await booking.update(
      {
        agentBroadcastHeld: true,
        agentVisibleAt: null,
        orderExpireTime: null,
        placedOutsidePlatformHours: false,
        preferredShopAgentId: null,
        preferredShopExpiresAt: null,
        preferredShopBroadcastDone: false,
      },
      { where: { id: bookingId } }
    );
    return { agentBroadcastHeld: true, notifiedCount: 0, mode: 'held_zone_closed' };
  }

  const preferredEnabled = await runtimeSettings.getBoolean('preferredShopEnabled');
  const preferredWindowMins = preferredEnabled
    ? await runtimeSettings.getInteger('preferredShopWindowMinutes')
    : PREFERRED_SHOP_WINDOW_MINUTES;
  const preferredShop = preferredEnabled
    ? await customerOrderService.findPreferredShopForCustomer(customerId, zoneId, servicesPayload)
    : null;
  const visibleAt = new Date();
  const expireTime = getOrderExpireTime(resolvedTz);

  if (preferredShop) {
    const preferredShopExpiresAt = new Date(Date.now() + preferredWindowMins * 60 * 1000);
    await booking.update(
      {
        agentBroadcastHeld: false,
        agentVisibleAt: visibleAt,
        orderExpireTime: expireTime,
        placedOutsidePlatformHours: false,
        preferredShopAgentId: preferredShop.user.id,
        preferredShopExpiresAt,
        preferredShopBroadcastDone: false,
      },
      { where: { id: bookingId } }
    );

    const bookingDetailsForNotify = await booking.findOne({
      where: { id: bookingId },
      include: [
        {
          model: users,
          as: 'customer',
          attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'userTypeId', 'image'],
        },
        {
          model: addressDb,
          as: 'pickupAddress',
          attributes: ['id', 'streetAddress', 'district', 'province', 'postalcode', 'lat', 'lng', 'addressType'],
        },
        {
          model: billingDetails,
          as: 'billingDetail',
          attributes: ['total', 'serviceCharge', 'categoryCharge'],
        },
        {
          model: zone,
          attributes: ['id', 'zoneMinimumAmount', 'serviceCharge', 'currencyUnitId'],
        },
      ],
    });

    const sent = bookingDetailsForNotify
      ? await customerOrderService.notifyPreferredShopOnly(
          bookingId,
          preferredShop,
          bookingDetailsForNotify,
          collectionDate,
          collectionTimeTo,
          collectionTimeFrom,
          deliveryDate,
          deliveryTimeTo,
          deliveryTimeFrom,
          resolvedTz,
          preferredWindowMins
        )
      : false;

    if (sent) {
      return { agentBroadcastHeld: false, notifiedCount: 1, mode: 'preferred_shop_only' };
    }
  }

  await booking.update(
    {
      agentBroadcastHeld: false,
      agentVisibleAt: visibleAt,
      orderExpireTime: expireTime,
      placedOutsidePlatformHours: false,
      preferredShopAgentId: null,
      preferredShopExpiresAt: null,
      preferredShopBroadcastDone: true,
    },
    { where: { id: bookingId } }
  );

  const result = await customerOrderService.bookingEventSentCheckTheShops(
    bookingId,
    zoneId,
    collectionDate,
    collectionTimeTo,
    collectionTimeFrom,
    deliveryDate,
    deliveryTimeTo,
    deliveryTimeFrom,
    servicesPayload,
    resolvedTz
  );

  if (!result?.notifiedCount) {
    await booking.update(
      {
        agentBroadcastHeld: true,
        agentVisibleAt: null,
        orderExpireTime: null,
      },
      { where: { id: bookingId } }
    );
    return { agentBroadcastHeld: true, notifiedCount: 0, mode: 'held_no_agents' };
  }

  return {
    agentBroadcastHeld: false,
    notifiedCount: Number(result.notifiedCount || 0),
    mode: 'broadcast',
  };
}

async function generateNextBookingFromCompleted({
  bookingId,
  actorUserId = null,
  timeZone = null,
} = {}) {
  const sourceBookingId = Number(bookingId);
  if (!Number.isFinite(sourceBookingId) || sourceBookingId <= 0) {
    return { generated: false, reason: 'invalid_booking_id' };
  }

  const runtimeSettings = require('../Admin/runtimeSettingsService');
  const enabled = await runtimeSettings.getBoolean('recurringAutoCreateEnabled');
  if (!enabled) return { generated: false, reason: 'recurring_disabled' };

  const tx = await db.sequelize.transaction();
  try {
    const source = await booking.findByPk(sourceBookingId, {
      include: [
        {
          model: customerSelectedService,
          required: false,
          include: [
            { model: customerSelectedServiceLine, as: 'serviceLines', required: false },
            { model: customerSelectedServiceAddOn, as: 'addOns', required: false },
          ],
        },
        { model: billingDetails, as: 'billingDetail', required: false },
        { model: tip, as: 'tips', required: false },
      ],
      lock: tx.LOCK.UPDATE,
      transaction: tx,
    });

    if (!source) {
      await tx.rollback();
      return { generated: false, reason: 'source_not_found' };
    }
    if (!isRecurringFrequency(source.frequency)) {
      await tx.rollback();
      return { generated: false, reason: 'just_once' };
    }

    const existingChild = source.recurringNextBookingId
      ? await booking.findByPk(source.recurringNextBookingId, { transaction: tx })
      : await booking.findOne({
          where: { recurringSourceBookingId: source.id },
          order: [['id', 'DESC']],
          transaction: tx,
        });
    if (existingChild) {
      if (!source.recurringNextBookingId) {
        await source.update({ recurringNextBookingId: existingChild.id }, { transaction: tx });
      }
      await tx.commit();
      return {
        generated: false,
        reason: 'already_generated',
        bookingId: existingChild.id,
      };
    }

    const intervalDays = getRecurringIntervalDays(source.frequency);
    const nextCollectionDate = shiftDateByDays(source.collectionDate, intervalDays);
    const nextDeliveryDate = shiftDateByDays(source.deliveryDate, intervalDays);
    if (!nextCollectionDate || !nextDeliveryDate) {
      await tx.rollback();
      return { generated: false, reason: 'invalid_source_dates' };
    }

    const plan = await ensurePlanForBooking(source.id, tx);
    const created = await booking.create(
      {
        collectionDate: nextCollectionDate,
        collectionTimeFrom: source.collectionTimeFrom,
        collectionTimeTo: source.collectionTimeTo,
        driverInstruction: source.driverInstruction || null,
        frequency: normalizeFrequencyLabel(source.frequency),
        deliveryDate: nextDeliveryDate,
        deliveryTimeFrom: source.deliveryTimeFrom,
        deliveryTimeTo: source.deliveryTimeTo,
        customerId: source.customerId,
        bookingStatusId: 1,
        pickupAddresId: source.pickupAddresId,
        dropOffAddressId: source.dropOffAddressId,
        totalItems: source.totalItems || 0,
        totalBags: source.totalBags != null ? source.totalBags : null,
        sameBagForAllServices: source.sameBagForAllServices !== false,
        paymentConfirmed: false,
        partialPayment: false,
        zoneId: source.zoneId,
        driverInstructionOptions: source.driverInstructionOptions,
        driverInstructionOptions1: source.driverInstructionOptions1,
        subTotal: source.subTotal || 0,
        paymentType: source.paymentType || 'card',
        operationalTimeZone: source.operationalTimeZone || timeZone || null,
        customerLocalTimeZone: source.customerLocalTimeZone || null,
        recurringPlanId: plan?.id || null,
        recurringSourceBookingId: source.id,
        recurringCycleDate: nextCollectionDate.toISOString().slice(0, 10),
        isRecurringAutoCreated: true,
        preferredShopAgentId: null,
        preferredShopExpiresAt: null,
        preferredShopBroadcastDone: false,
      },
      { transaction: tx }
    );

    await created.update(
      { orderTrackId: `${created.id}-${makeOrderTrackSuffix()}` },
      { transaction: tx }
    );

    await source.update(
      {
        recurringNextBookingId: created.id,
        recurringPlanId: plan?.id || source.recurringPlanId || null,
      },
      { transaction: tx }
    );

    if (plan) {
      await plan.update(
        {
          frequency: normalizeFrequencyLabel(source.frequency),
          status: 'active',
          nextRunAt: nextCollectionDate,
          lastGeneratedFromBookingId: source.id,
          lastGeneratedAt: new Date(),
          failureCount: 0,
          notes: null,
        },
        { transaction: tx }
      );
    }

    await cloneServiceRows(source.id, created.id, tx);

    const sourceBilling = source.billingDetail
      ? source.billingDetail.get({ plain: true })
      : null;
    await billingDetails.create(
      {
        bookingId: created.id,
        upfrontAmount: sourceBilling?.upfrontAmount ?? 0,
        discount: 0,
        total: sourceBilling?.upfrontAmount ?? 0,
        serviceCharge: sourceBilling?.serviceCharge ?? 0,
        categoryCharge: 0,
        paymentStatus: 'Pending',
      },
      { transaction: tx }
    );

    const sourceTip = Array.isArray(source.tips) ? source.tips[0] : null;
    if (sourceTip && Number(sourceTip.amount) > 0) {
      await tip.create(
        {
          bookingId: created.id,
          amount: Number(sourceTip.amount),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { transaction: tx }
      );
    }

    await tx.commit();

    const servicesPayload = (source.customerSelectedServices || [])
      .map((svc) => ({ serviceId: Number(svc.serviceId) }))
      .filter((svc) => Number.isFinite(svc.serviceId) && svc.serviceId > 0);

    const assignmentResult = await applyAssignmentVisibility({
      bookingId: created.id,
      customerId: created.customerId,
      zoneId: created.zoneId,
      servicesPayload,
      collectionDate: created.collectionDate,
      collectionTimeFrom: created.collectionTimeFrom,
      collectionTimeTo: created.collectionTimeTo,
      deliveryDate: created.deliveryDate,
      deliveryTimeFrom: created.deliveryTimeFrom,
      deliveryTimeTo: created.deliveryTimeTo,
      fallbackTimeZone: created.operationalTimeZone || timeZone,
    });

    console.log(
      `[recurring] source=${source.id} generated booking=${created.id} mode=${assignmentResult.mode}`
    );

    return {
      generated: true,
      sourceBookingId: source.id,
      bookingId: created.id,
      recurringPlanId: plan?.id || null,
      nextCollectionDate: created.collectionDate,
      nextDeliveryDate: created.deliveryDate,
      agentBroadcastHeld: Boolean(assignmentResult.agentBroadcastHeld),
      notifiedCount: Number(assignmentResult.notifiedCount || 0),
      mode: assignmentResult.mode,
      generatedBy: actorUserId,
    };
  } catch (err) {
    await tx.rollback();
    console.error('[recurring] generateNextBookingFromCompleted failed:', err?.message || err);

    const source = await booking.findByPk(sourceBookingId).catch(() => null);
    if (source?.recurringPlanId) {
      const plan = await recurringPlan.findByPk(source.recurringPlanId).catch(() => null);
      if (plan) {
        const nextFailureCount = Number(plan.failureCount || 0) + 1;
        const shouldPause = nextFailureCount >= Number(plan.maxFailures || 3);
        await plan
          .update({
            failureCount: nextFailureCount,
            status: shouldPause ? 'paused' : plan.status,
            notes: String(err?.message || err || 'recurring generation failed').slice(0, 500),
          })
          .catch(() => {});
      }
    }
    throw err;
  }
}

function buildRecurringDeliveryHint(bookingRow) {
  const frequency = normalizeFrequencyLabel(bookingRow?.frequency);
  if (!isRecurringFrequency(frequency)) {
    return {
      recurringEnabled: false,
      requiresReturnPickup: false,
      frequency,
      nextCollectionDate: null,
    };
  }
  const intervalDays = getRecurringIntervalDays(frequency);
  const nextCollectionDate = shiftDateByDays(bookingRow?.collectionDate, intervalDays);
  return {
    recurringEnabled: true,
    requiresReturnPickup: true,
    frequency,
    nextCollectionDate:
      nextCollectionDate && Number.isFinite(nextCollectionDate.getTime())
        ? nextCollectionDate.toISOString().slice(0, 10)
        : null,
  };
}

module.exports = {
  isRecurringFrequency,
  buildRecurringDeliveryHint,
  ensurePlanForBooking,
  generateNextBookingFromCompleted,
};
