'use strict';

const otpGenerator = require('otp-generator');
const { Op } = require('sequelize');
const db = require('../../models');
const {
  booking,
  recurringPlan,
  customerSelectedService,
  customerSelectedServiceAddOn,
  customerSelectedServiceLine,
  bookingPreference,
  billingDetails,
  tip,
  users,
  addressDb,
  zone,
  customerOriginalServiceSnapshot,
  customerOriginalPreferenceSnapshot,
  customerSelectedRepairItem,
  customerSelectedRepairItemOption,
  customerSelectedRepairItemImage,
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
const {
  looksLikeCustomerIntentRow,
  pickCustomerIntentCloneSource,
} = require('../../utils/recurringCloneIntent');
const { isUserBlocked } = require('../../utils/accountBlocked');

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

/**
 * The effective GENERATION interval (in ms) for a recurring frequency.
 *
 * Normally this is the frequency's real cadence (7 / 14 / 28 days). When the
 * admin runtime setting `recurringTestModeEnabled` is ON, every recurring
 * frequency is compressed to `recurringTestIntervalMinutes` minutes so the
 * whole cycle can be exercised in minutes instead of waiting days.
 *
 * NOTE: this only controls WHEN the next order is generated. The generated
 * order's own collection/delivery dates still shift by the real day interval
 * (see shiftDateByDays usage) so the cloned order always carries sane dates.
 */
async function getEffectiveIntervalMs(frequency) {
  const runtimeSettings = require('../Admin/runtimeSettingsService');
  let testMode = false;
  try {
    testMode = await runtimeSettings.getBoolean('recurringTestModeEnabled');
  } catch (_) {
    testMode = false;
  }
  if (testMode) {
    let minutes = 3;
    try {
      minutes = await runtimeSettings.getInteger('recurringTestIntervalMinutes');
    } catch (_) {
      minutes = 3;
    }
    return Math.max(1, Number(minutes) || 1) * 60 * 1000;
  }
  const days = getRecurringIntervalDays(frequency);
  return days * 24 * 60 * 60 * 1000;
}

/**
 * When the next cycle should be generated, measured from `fromInstant`
 * (usually now). Returns null for non-recurring / zero interval.
 */
async function computeNextRunAt(fromInstant, frequency) {
  const ms = await getEffectiveIntervalMs(frequency);
  if (!ms || ms <= 0) return null;
  const base = new Date(fromInstant);
  if (!Number.isFinite(base.getTime())) return null;
  return new Date(base.getTime() + ms);
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
    // Arm the first cycle one interval AFTER the order is placed (now), so the
    // next order is generated on schedule — NOT immediately on completion.
    const firstRunAt = await computeNextRunAt(new Date(), row.frequency);
    plan = await recurringPlan.create(
      {
        customerId: row.customerId,
        sourceBookingId: rootSourceBookingId,
        frequency: normalizeFrequencyLabel(row.frequency),
        status: 'active',
        nextRunAt: firstRunAt,
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

async function loadIntentRowsForClone(sourceBookingId, transaction) {
  try {
    const {
      ensureCustomerDeclaredSnapshot,
    } = require('../Agent/customerDeclaredServicesService');
    await ensureCustomerDeclaredSnapshot(sourceBookingId);
  } catch (err) {
    console.warn(
      `[recurring] snapshot ensure failed for ${sourceBookingId}:`,
      err?.message || err
    );
  }

  const snapshotRows = await customerOriginalServiceSnapshot.findAll({
    where: { bookingId: sourceBookingId },
    include: [
      {
        model: customerOriginalPreferenceSnapshot,
        as: 'preferences',
        required: false,
      },
    ],
    order: [['id', 'ASC']],
    transaction,
  });

  const cssRows = await customerSelectedService.findAll({
    where: { bookingId: sourceBookingId },
    include: [
      {
        model: bookingPreference,
        as: 'selectedServicePreferences',
        required: false,
      },
    ],
    order: [['id', 'ASC']],
    transaction,
  });

  return pickCustomerIntentCloneSource({
    snapshotRows: snapshotRows.map((row) => row.get({ plain: true })),
    cssRows: cssRows.map((row) => row.get({ plain: true })),
  });
}

async function cloneCustomerDeclaredRepairs({
  sourceBookingId,
  newBookingId,
  newCssByServiceId,
  zoneId,
  transaction,
}) {
  const sourceCss = await customerSelectedService.findAll({
    where: { bookingId: sourceBookingId },
    attributes: ['id', 'serviceId', 'subCategoryId'],
    transaction,
  });
  const intentCssIds = new Set(
    sourceCss.filter(looksLikeCustomerIntentRow).map((row) => row.id)
  );
  const declaredServiceIds = new Set(
    [...newCssByServiceId.keys()].map((id) => Number(id)).filter(Number.isFinite)
  );

  const repairs = await customerSelectedRepairItem.findAll({
    where: { bookingId: sourceBookingId },
    include: [
      { model: customerSelectedRepairItemOption, as: 'options', required: false },
      { model: customerSelectedRepairItemImage, as: 'images', required: false },
    ],
    order: [['id', 'ASC']],
    transaction,
  });

  for (const repair of repairs) {
    const plain = repair.get({ plain: true });
    const parentId = plain.customerSelectedServiceId;
    if (parentId && intentCssIds.size && !intentCssIds.has(parentId)) {
      continue;
    }
    const serviceId = Number(plain.serviceId);
    if (Number.isFinite(serviceId) && declaredServiceIds.size && !declaredServiceIds.has(serviceId)) {
      continue;
    }
    const created = await customerSelectedRepairItem.create(
      {
        bookingId: newBookingId,
        customerSelectedServiceId: Number.isFinite(serviceId)
          ? newCssByServiceId.get(serviceId) || null
          : null,
        serviceId,
        repairGarmentId: plain.repairGarmentId,
        garmentName: plain.garmentName,
        quantity: plain.quantity || 1,
        instruction: plain.instruction || null,
      },
      { transaction }
    );

    for (const option of plain.options || []) {
      let optionPrice = option.price || 0;
      if (option.repairOptionId && zoneId) {
        try {
          const zoneCatalogService = require("../Admin/zoneCatalogService");
          const resolved = await zoneCatalogService.resolvePrice(zoneId, {
            repairOptionId: option.repairOptionId,
          });
          optionPrice = resolved.price;
        } catch (_) {
          /* keep snapshot if catalog gone */
        }
      }
      await customerSelectedRepairItemOption.create(
        {
          customerSelectedRepairItemId: created.id,
          repairOptionId: option.repairOptionId,
          optionName: option.optionName,
          price: optionPrice,
        },
        { transaction }
      );
    }
    for (const image of plain.images || []) {
      await customerSelectedRepairItemImage.create(
        {
          customerSelectedRepairItemId: created.id,
          imageUrl: image.imageUrl,
          sortOrder: image.sortOrder || 1,
        },
        { transaction }
      );
    }
  }
}

async function cloneServiceRows(sourceBookingId, newBookingId, zoneId, transaction) {
  const picked = await loadIntentRowsForClone(sourceBookingId, transaction);
  const rows = picked.rows || [];
  const now = new Date();
  const newCssByServiceId = new Map();

  if (!rows.length) {
    console.warn(
      `[recurring] no customer-intent services to clone from booking=${sourceBookingId}`
    );
    return { serviceIds: [] };
  }

  const zoneCatalogService = require("../Admin/zoneCatalogService");
  for (const plain of rows) {
    const serviceId = Number(plain.serviceId);
    let categoryPrice = plain.categoryPrice ?? null;
    const subCategoryId = plain.subCategoryId || null;
    if (subCategoryId && zoneId) {
      try {
        const resolved = await zoneCatalogService.resolvePrice(zoneId, {
          subCategoryId,
        });
        categoryPrice = resolved.price;
      } catch (_) {
        /* keep prior snapshot if item disappeared */
      }
    }
    const created = await customerSelectedService.create(
      {
        bookingId: newBookingId,
        serviceId: Number.isFinite(serviceId) ? serviceId : plain.serviceId,
        categoryId: plain.categoryId || null,
        subCategoryId,
        date: plain.date || now,
        time: plain.time || '00:00:00',
        servicePrice: null,
        categoryPrice,
        items: plain.items ?? null,
        bags: plain.bags ?? null,
        status: true,
        serviceInstruction: plain.serviceInstruction || null,
      },
      { transaction }
    );
    if (Number.isFinite(serviceId)) {
      newCssByServiceId.set(serviceId, created.id);
    }

    const prefs = plain.preferences || plain.selectedServicePreferences || [];
    if (prefs.length) {
      await bookingPreference.bulkCreate(
        prefs.map((p) => ({
          bookingId: newBookingId,
          customerSelectedServiceId: created.id,
          preferenceTypeId: p.preferenceTypeId,
          preferenceValueId: p.preferenceValueId,
          parentPreferenceValueId: p.parentPreferenceValueId || null,
          preferenceInstruction: p.preferenceInstruction || null,
          createdAt: now,
          updatedAt: now,
        })),
        { transaction }
      );
    }
  }

  const bookingLevelPrefs = await customerOriginalPreferenceSnapshot.findAll({
    where: { bookingId: sourceBookingId, snapshotServiceId: null },
    order: [['id', 'ASC']],
    transaction,
  });
  if (bookingLevelPrefs.length) {
    await bookingPreference.bulkCreate(
      bookingLevelPrefs.map((p) => {
        const plain = p.get({ plain: true });
        return {
          bookingId: newBookingId,
          customerSelectedServiceId: null,
          preferenceTypeId: plain.preferenceTypeId,
          preferenceValueId: plain.preferenceValueId,
          parentPreferenceValueId: plain.parentPreferenceValueId || null,
          preferenceInstruction: plain.preferenceInstruction || null,
          createdAt: now,
          updatedAt: now,
        };
      }),
      { transaction }
    );
  }

  await cloneCustomerDeclaredRepairs({
    sourceBookingId,
    newBookingId,
    newCssByServiceId,
    zoneId,
    transaction,
  });

  return {
    serviceIds: [...newCssByServiceId.keys()],
    cloneSource: picked.source,
  };
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
  const { resolvePreferredShop, SKIP_REASONS } = require('../preferredShopResolver');
  const preferredResult = preferredEnabled
    ? await resolvePreferredShop({
        customerId,
        zoneId,
        services: servicesPayload,
        collectionDate,
        collectionTimeFrom,
        collectionTimeTo,
        deliveryDate,
        deliveryTimeFrom,
        deliveryTimeTo,
        excludeBookingId: bookingId,
        timeZone: resolvedTz,
      })
    : { shop: null, skipReason: SKIP_REASONS.DISABLED };
  const preferredShop = preferredResult.shop;
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
        preferredShopSkipReason: null,
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
      preferredShopSkipReason: preferredResult.skipReason || null,
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

    const customerUser = await users.findByPk(source.customerId, {
      attributes: ['id', 'status', 'defaultPaymentMethodId', 'stripeCustomerId'],
      transaction: tx,
    });
    if (!customerUser || isUserBlocked(customerUser.status)) {
      await tx.rollback();
      return { generated: false, reason: 'customer_blocked' };
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

    const paymentType = source.paymentType || 'card';
    const paymentMethodId =
      paymentType === 'card'
        ? source.paymentMethodId || customerUser?.defaultPaymentMethodId || null
        : null;

    const plan = await ensurePlanForBooking(source.id, tx);
    if (plan && plan.status !== 'active') {
      await tx.rollback();
      return { generated: false, reason: 'plan_not_active' };
    }
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
        noOfBags: source.noOfBags != null ? source.noOfBags : null,
        sameBagForAllServices: source.sameBagForAllServices !== false,
        paymentConfirmed: false,
        partialPayment: paymentType !== 'cash',
        zoneId: source.zoneId,
        driverInstructionOptions: source.driverInstructionOptions,
        driverInstructionOptions1: source.driverInstructionOptions1,
        subTotal: source.subTotal || 0,
        paymentType,
        paymentMethodId,
        setupIntentId: null,
        paymentIntentId: null,
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
      // Schedule the FOLLOWING cycle one interval from now (generation time),
      // so the chain keeps rolling on a time-based cadence rather than firing
      // instantly. The scheduler reads this nextRunAt.
      const followingRunAt = await computeNextRunAt(new Date(), source.frequency);
      await plan.update(
        {
          frequency: normalizeFrequencyLabel(source.frequency),
          status: 'active',
          nextRunAt: followingRunAt,
          lastGeneratedFromBookingId: source.id,
          lastGeneratedAt: new Date(),
          failureCount: 0,
          notes: null,
        },
        { transaction: tx }
      );
    }

    const cloned = await cloneServiceRows(source.id, created.id, created.zoneId || source.zoneId, tx);

    const sourceBilling = source.billingDetail
      ? source.billingDetail.get({ plain: true })
      : null;
    const zoneRow = source.zoneId
      ? await zone.findByPk(source.zoneId, {
          attributes: ['id', 'zoneMinimumAmount', 'serviceCharge'],
          transaction: tx,
        })
      : null;
    const upfrontAmount =
      Number(zoneRow?.zoneMinimumAmount ?? sourceBilling?.upfrontAmount ?? 0) || 0;
    const serviceCharge =
      Number(zoneRow?.serviceCharge ?? sourceBilling?.serviceCharge ?? 0) || 0;
    const tipAmount = Array.isArray(source.tips)
      ? Number(source.tips[0]?.amount || 0) || 0
      : 0;
    const prepaidTotal = Number(
      (upfrontAmount + serviceCharge + tipAmount).toFixed(2)
    );

    await billingDetails.create(
      {
        bookingId: created.id,
        upfrontAmount,
        discount: 0,
        total: prepaidTotal,
        serviceCharge,
        categoryCharge: 0,
        paymentStatus: 'Pending',
        prepaidTipAmount:
          String(source.paymentType || '').toLowerCase() === 'cash' ? 0 : tipAmount,
      },
      { transaction: tx }
    );

    await created.update({ subTotal: prepaidTotal }, { transaction: tx });

    if (tipAmount > 0) {
      await tip.create(
        {
          bookingId: created.id,
          amount: tipAmount,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { transaction: tx }
      );
    }

    await tx.commit();

    try {
      const {
        ensureCustomerDeclaredSnapshot,
      } = require('../Agent/customerDeclaredServicesService');
      await ensureCustomerDeclaredSnapshot(created.id);
    } catch (err) {
      console.warn(
        `[recurring] snapshot for generated booking ${created.id} failed:`,
        err?.message || err
      );
    }

    const servicesPayload = (cloned.serviceIds || [])
      .map((serviceId) => ({ serviceId: Number(serviceId) }))
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
      `[recurring] source=${source.id} generated booking=${created.id} mode=${assignmentResult.mode} clone=${cloned.cloneSource || 'unknown'} paymentMethod=${paymentMethodId ? 'attached' : 'missing'}`
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

// ─── Time-based recurring generation scheduler ───────────────────────────────
// Decoupled from order completion: a plan is "armed" (nextRunAt set) at order
// placement and each cycle. This job creates + broadcasts the next order only
// when its scheduled time arrives.

const RECURRING_JOB_INTERVAL_MS =
  Number(process.env.RECURRING_JOB_INTERVAL_MS) > 0
    ? Number(process.env.RECURRING_JOB_INTERVAL_MS)
    : 30 * 1000;
let recurringTimer = null;

/**
 * Process every active recurring plan whose nextRunAt is due. Generates one
 * child per due plan (from the current tail of the chain) and advances the
 * schedule. Safe to run repeatedly — it never double-generates a cycle.
 */
async function runDueRecurringPlans({ limit = 100 } = {}) {
  const runtimeSettings = require('../Admin/runtimeSettingsService');
  let enabled = true;
  try {
    enabled = await runtimeSettings.getBoolean('recurringAutoCreateEnabled');
  } catch (_) {
    enabled = true;
  }
  if (!enabled) return { generated: 0, skipped: 'disabled' };

  const now = new Date();
  const duePlans = await recurringPlan.findAll({
    where: {
      status: 'active',
      nextRunAt: { [Op.ne]: null, [Op.lte]: now },
    },
    order: [['nextRunAt', 'ASC']],
    limit,
  });
  if (!duePlans.length) return { generated: 0, due: 0 };

  let generated = 0;
  for (const plan of duePlans) {
    try {
      // Generate from the current tail of the chain (latest booking with no
      // child yet). Falls back to the root source booking.
      const tail = await booking.findOne({
        where: { recurringPlanId: plan.id, recurringNextBookingId: null },
        order: [['id', 'DESC']],
        attributes: ['id'],
      });
      const sourceId = tail?.id || plan.sourceBookingId;
      if (!sourceId) {
        await plan.update({ nextRunAt: null, notes: 'no source booking to generate from' });
        continue;
      }

      const result = await generateNextBookingFromCompleted({ bookingId: sourceId });

      if (result.generated) {
        generated += 1;
        // nextRunAt already advanced inside generateNextBookingFromCompleted.
      } else if (result.reason === 'already_generated') {
        // Tail already had a child — advance so we pick the new tail next tick.
        await plan.update({ nextRunAt: await computeNextRunAt(new Date(), plan.frequency) });
      } else if (
        ['just_once', 'source_not_found', 'customer_blocked', 'plan_not_active', 'invalid_source_dates']
          .includes(result.reason)
      ) {
        // Terminal for this plan — stop scheduling to avoid a hot loop.
        await plan.update({ nextRunAt: null, notes: `stopped: ${result.reason}` });
      }
    } catch (err) {
      console.error(`[recurring] scheduler error for plan ${plan.id}:`, err?.message || err);
      // generateNextBookingFromCompleted already bumps failureCount / may pause.
      // Push nextRunAt forward so a transient error doesn't hot-loop every tick.
      try {
        await plan.reload();
        if (plan.status === 'active') {
          await plan.update({ nextRunAt: await computeNextRunAt(new Date(), plan.frequency) });
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  return { generated, due: duePlans.length };
}

function startRecurringGenerationJob() {
  if (recurringTimer) return;
  const tick = async () => {
    try {
      await runDueRecurringPlans();
    } catch (err) {
      console.error('[recurring] generation job error:', err?.message || err);
    } finally {
      recurringTimer = setTimeout(tick, RECURRING_JOB_INTERVAL_MS);
    }
  };
  recurringTimer = setTimeout(tick, 0);
  console.log(
    `[recurring] generation job scheduled every ${RECURRING_JOB_INTERVAL_MS / 1000}s`
  );
}

function stopRecurringGenerationJob() {
  if (recurringTimer) {
    clearTimeout(recurringTimer);
    recurringTimer = null;
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
  computeNextRunAt,
  getEffectiveIntervalMs,
  runDueRecurringPlans,
  startRecurringGenerationJob,
  stopRecurringGenerationJob,
};
