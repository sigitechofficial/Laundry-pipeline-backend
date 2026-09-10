"use strict";

const { Op } = require("sequelize");
const sequelize = require("../../models").sequelize;
const {
  booking,
  billingDetails,
  bookingStatus,
  bussinessInformation,
  addressDb,
  users,
  wallet,
  tip,
  zone,
  units,
} = require("../../models");
const { NotFoundError, ValidationError } = require("../../middlewares/universalErrorHandler");
const { COMPLETED, CANCELLED, REFUNDED } = require("../../constants/bookingStatusIds");
const agentWalletService = require("../Agent/agentWalletService");
const {
  parsePeriodQuery,
  buildPeriodRange,
  previousPeriodRange,
  sqlDateTime,
  toIsoDate,
  money,
  pctChange,
} = require("./shopRevenuePeriod");

const COLLECTED_STATUSES = [16, COMPLETED];
const COLLECTED_SQL = COLLECTED_STATUSES.join(",");

const T = {
  bookings: booking.getTableName(),
  billing: billingDetails.getTableName(),
  tips: tip.getTableName(),
};

function emptyTotals() {
  return {
    ordersCompleted: 0,
    grossRevenue: 0,
    laundrySubtotal: 0,
    serviceCharge: 0,
    discount: 0,
    platformCommission: 0,
    shopNet: 0,
    driverEarnings: 0,
    rescheduleCharge: 0,
    cashGross: 0,
    cardGross: 0,
    avgOrderValue: 0,
    bookingTips: 0,
    extraTips: 0,
    cancelledOrders: 0,
    cancelledValue: 0,
    refundedOrders: 0,
    refundedValue: 0,
    openOrders: 0,
  };
}

async function query(sql, replacements = {}) {
  const [rows] = await sequelize.query(sql, { replacements });
  return rows;
}

async function resolveShop(shopId) {
  const id = parseInt(shopId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new NotFoundError("Shop not found");
  }

  const include = [
    {
      model: addressDb,
      required: false,
      attributes: ["id", "userId", "streetAddress", "district", "province", "zoneId"],
      include: [
        {
          model: zone,
          attributes: ["id", "name"],
          required: false,
          include: [
            {
              model: units,
              as: "currencyUnitZ",
              attributes: ["symbol"],
              required: false,
            },
          ],
        },
      ],
    },
  ];

  let shop = await bussinessInformation.findOne({ where: { id }, include });
  if (!shop) {
    shop = await bussinessInformation.findOne({ where: { agentId: id }, include });
  }
  if (!shop) {
    shop = await bussinessInformation.findOne({ where: { shopAddressId: id }, include });
  }
  if (!shop) {
    throw new NotFoundError("Shop not found");
  }

  const address = shop.addressDb;
  if (!address?.id) {
    throw new NotFoundError("Shop address not found");
  }

  const symbol = address.zone?.currencyUnitZ?.symbol;
  const currencyCode =
    symbol && String(symbol).trim().toUpperCase() === "£"
      ? "GBP"
      : symbol
        ? String(symbol).trim()
        : "GBP";
  const currencySymbol = symbol && String(symbol).trim() ? String(symbol).trim() : "£";

  return {
    businessInfoId: shop.id,
    shopName: shop.shopName || null,
    agentUserId: address.userId || shop.agentId || null,
    addressId: address.id,
    zoneId: address.zoneId || null,
    zoneName: address.zone?.name || null,
    currencyCode,
    currencySymbol,
  };
}

function datePredicate(range, column, replacements, startKey, endKey) {
  if (!range) return "1=1";
  replacements[startKey] = sqlDateTime(range.start);
  replacements[endKey] = sqlDateTime(range.end);
  return `${column} BETWEEN :${startKey} AND :${endKey}`;
}

function mapTotals(row) {
  const base = emptyTotals();
  if (!row) return base;
  const shopNetBilled = money(row.shopNetBilled);
  const shopNetDerived = money(row.shopNetDerived);
  return {
    ordersCompleted: Number(row.ordersCompleted || 0),
    grossRevenue: money(row.grossRevenue),
    laundrySubtotal: money(row.laundrySubtotal),
    serviceCharge: money(row.serviceCharge),
    discount: money(row.discount),
    platformCommission: money(row.platformCommission),
    shopNet: shopNetBilled > 0 ? shopNetBilled : shopNetDerived,
    driverEarnings: money(row.driverEarnings),
    rescheduleCharge: money(row.rescheduleCharge),
    cashGross: money(row.cashGross),
    cardGross: money(row.cardGross),
    avgOrderValue: money(row.avgOrderValue),
    bookingTips: money(row.bookingTips),
    extraTips: money(row.extraTips),
    cancelledOrders: Number(row.cancelledOrders || 0),
    cancelledValue: money(row.cancelledValue),
    refundedOrders: Number(row.refundedOrders || 0),
    refundedValue: money(row.refundedValue),
    openOrders: Number(row.openOrders || 0),
  };
}

async function loadPeriodTotals(addressId, range) {
  const replacements = { addressId };
  const collectedDate = datePredicate(range, "b.collectionDate", replacements, "cStart", "cEnd");
  const anyDate = datePredicate(range, "b.collectionDate", replacements, "aStart", "aEnd");

  const [collected] = await query(
    `
    SELECT
      COUNT(DISTINCT b.id) AS ordersCompleted,
      COALESCE(SUM(bd.total), 0) AS grossRevenue,
      COALESCE(SUM(bd.categoryCharge), 0) AS laundrySubtotal,
      COALESCE(SUM(bd.serviceCharge), 0) AS serviceCharge,
      COALESCE(SUM(bd.discount), 0) AS discount,
      COALESCE(SUM(bd.zoneAdminCommission), 0) AS platformCommission,
      COALESCE(SUM(bd.agentEarning), 0) AS shopNetBilled,
      COALESCE(SUM(bd.total), 0)
        - COALESCE(SUM(bd.zoneAdminCommission), 0)
        - COALESCE(SUM(bd.pickupDriverEarning + bd.deliveryDriverEarning), 0)
        - COALESCE(SUM(b.rescheduleCharge), 0) AS shopNetDerived,
      COALESCE(SUM(bd.pickupDriverEarning + bd.deliveryDriverEarning), 0) AS driverEarnings,
      COALESCE(SUM(b.rescheduleCharge), 0) AS rescheduleCharge,
      COALESCE(SUM(CASE WHEN b.paymentType = 'cash' THEN bd.total ELSE 0 END), 0) AS cashGross,
      COALESCE(SUM(CASE WHEN b.paymentType = 'cash' THEN 0 ELSE bd.total END), 0) AS cardGross,
      COALESCE(AVG(bd.total), 0) AS avgOrderValue,
      COALESCE(SUM(tips.bookingTips), 0) AS bookingTips,
      COALESCE(SUM(tips.extraTips), 0) AS extraTips
    FROM \`${T.bookings}\` b
    LEFT JOIN \`${T.billing}\` bd ON bd.bookingId = b.id
    LEFT JOIN (
      SELECT
        bookingId,
        COALESCE(SUM(CASE WHEN source = 'post_complete' THEN amount ELSE 0 END), 0) AS extraTips,
        COALESCE(SUM(CASE WHEN source <> 'post_complete' OR source IS NULL THEN amount ELSE 0 END), 0) AS bookingTips
      FROM \`${T.tips}\`
      GROUP BY bookingId
    ) tips ON tips.bookingId = b.id
    WHERE b.laundryShopId = :addressId
      AND b.deletedAt IS NULL
      AND b.bookingStatusId IN (${COLLECTED_SQL})
      AND ${collectedDate}
    `,
    replacements
  );

  const [lifecycle] = await query(
    `
    SELECT
      COALESCE(SUM(CASE WHEN b.bookingStatusId = ${CANCELLED} THEN 1 ELSE 0 END), 0) AS cancelledOrders,
      COALESCE(SUM(CASE WHEN b.bookingStatusId = ${CANCELLED} THEN COALESCE(bd.total, b.orderAmount, 0) ELSE 0 END), 0) AS cancelledValue,
      COALESCE(SUM(CASE WHEN b.bookingStatusId = ${REFUNDED} THEN 1 ELSE 0 END), 0) AS refundedOrders,
      COALESCE(SUM(CASE WHEN b.bookingStatusId = ${REFUNDED} THEN COALESCE(bd.total, b.orderAmount, 0) ELSE 0 END), 0) AS refundedValue,
      COALESCE(SUM(CASE WHEN b.bookingStatusId NOT IN (${COLLECTED_SQL}, ${CANCELLED}, ${REFUNDED}) THEN 1 ELSE 0 END), 0) AS openOrders
    FROM \`${T.bookings}\` b
    LEFT JOIN \`${T.billing}\` bd ON bd.bookingId = b.id
    WHERE b.laundryShopId = :addressId
      AND b.deletedAt IS NULL
      AND ${anyDate}
    `,
    replacements
  );

  return mapTotals({ ...(collected || {}), ...(lifecycle || {}) });
}

async function loadSeries(addressId, range) {
  const replacements = { addressId };
  const collectedDate = datePredicate(range, "b.collectionDate", replacements, "sStart", "sEnd");
  const rows = await query(
    `
    SELECT
      DATE(b.collectionDate) AS date,
      COUNT(DISTINCT b.id) AS ordersCompleted,
      COALESCE(SUM(bd.total), 0) AS grossRevenue,
      COALESCE(SUM(bd.agentEarning), 0) AS shopNetBilled,
      COALESCE(SUM(bd.total), 0)
        - COALESCE(SUM(bd.zoneAdminCommission), 0)
        - COALESCE(SUM(bd.pickupDriverEarning + bd.deliveryDriverEarning), 0)
        - COALESCE(SUM(b.rescheduleCharge), 0) AS shopNetDerived
    FROM \`${T.bookings}\` b
    LEFT JOIN \`${T.billing}\` bd ON bd.bookingId = b.id
    WHERE b.laundryShopId = :addressId
      AND b.deletedAt IS NULL
      AND b.bookingStatusId IN (${COLLECTED_SQL})
      AND ${collectedDate}
    GROUP BY DATE(b.collectionDate)
    ORDER BY date ASC
    `,
    replacements
  );

  return rows.map((row) => {
    const billed = money(row.shopNetBilled);
    const derived = money(row.shopNetDerived);
    return {
      date: row.date ? String(row.date).slice(0, 10) : null,
      ordersCompleted: Number(row.ordersCompleted || 0),
      grossRevenue: money(row.grossRevenue),
      shopNet: billed > 0 ? billed : derived,
    };
  });
}

async function loadOrders(addressId, range, page, limit) {
  const where = {
    laundryShopId: addressId,
    bookingStatusId: { [Op.in]: COLLECTED_STATUSES },
  };
  if (range) {
    where.collectionDate = { [Op.between]: [range.start, range.end] };
  }

  const { count, rows } = await booking.findAndCountAll({
    where,
    include: [
      {
        model: users,
        as: "customer",
        attributes: ["id", "firstName", "lastName"],
        required: false,
      },
      {
        model: bookingStatus,
        attributes: ["id", "title"],
        required: false,
      },
      {
        model: billingDetails,
        as: "billingDetail",
        attributes: [
          "total",
          "categoryCharge",
          "serviceCharge",
          "discount",
          "zoneAdminCommission",
          "agentEarning",
          "pickupDriverEarning",
          "deliveryDriverEarning",
          "paymentStatus",
        ],
        required: false,
      },
    ],
    attributes: [
      "id",
      "orderTrackId",
      "collectionDate",
      "createdAt",
      "orderAmount",
      "paymentType",
      "balanceCollectedVia",
      "bookingStatusId",
      "rescheduleCharge",
    ],
    order: [
      ["collectionDate", "DESC"],
      ["id", "DESC"],
    ],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });

  const totalPages = count > 0 ? Math.ceil(count / limit) : 0;
  return {
    rows: rows.map((row) => {
      const plain = row.get({ plain: true });
      const bill = plain.billingDetail || {};
      const drivers =
        money(bill.pickupDriverEarning) + money(bill.deliveryDriverEarning);
      const gross = money(bill.total != null ? bill.total : plain.orderAmount);
      const shopNet =
        money(bill.agentEarning) ||
        money(gross - money(bill.zoneAdminCommission) - drivers - money(plain.rescheduleCharge));
      return {
        id: plain.id,
        orderTrackId: plain.orderTrackId || null,
        collectionDate: plain.collectionDate || null,
        createdAt: plain.createdAt || null,
        statusId: plain.bookingStatusId,
        status: plain.bookingStatus?.title || null,
        customer: [plain.customer?.firstName, plain.customer?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() || "—",
        paymentType: plain.paymentType || "card",
        balanceCollectedVia: plain.balanceCollectedVia || null,
        paymentStatus: bill.paymentStatus || null,
        gross,
        laundry: money(bill.categoryCharge),
        serviceCharge: money(bill.serviceCharge),
        discount: money(bill.discount),
        platformCommission: money(bill.zoneAdminCommission),
        shopNet,
        driverEarnings: drivers,
      };
    }),
    pagination: {
      page,
      limit,
      total: count,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

async function latestWalletAt(agentUserId, referenceType) {
  const row = await wallet.findOne({
    where: { userId: agentUserId, referenceType },
    attributes: ["createdAt"],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
  });
  return row?.createdAt || null;
}

async function listWalletLogs(agentUserId, referenceType, range, limit = 50) {
  const where = { userId: agentUserId, referenceType };
  if (range) {
    where.createdAt = { [Op.between]: [range.start, range.end] };
  }
  const rows = await wallet.findAll({
    where,
    attributes: [
      "id",
      "amount",
      "currency",
      "type",
      "status",
      "description",
      "stripeTransferId",
      "failureReason",
      "createdAt",
      "bookingId",
    ],
    include: [
      {
        model: booking,
        as: "booking",
        attributes: ["id", "orderTrackId"],
        required: false,
      },
    ],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit,
  });

  return rows.map((row) => {
    const plain = row.get({ plain: true });
    return {
      id: plain.id,
      amount: money(plain.amount),
      currency: plain.currency || "GBP",
      type: plain.type,
      status: plain.status,
      description: plain.description || "",
      stripeTransferId: plain.stripeTransferId || null,
      failureReason: plain.failureReason || null,
      createdAt: plain.createdAt,
      bookingId: plain.bookingId || null,
      orderTrackId: plain.booking?.orderTrackId || null,
    };
  });
}

async function periodWalletSum(agentUserId, referenceType, type, range) {
  const where = { userId: agentUserId, referenceType, type };
  if (range) {
    where.createdAt = { [Op.between]: [range.start, range.end] };
  }
  const value = await wallet.sum("amount", { where });
  return money(value);
}

async function getShopRevenue(shopId, rawQuery = {}) {
  const filters = parsePeriodQuery(rawQuery);
  if (filters.period === "custom" && (!filters.startDate || !filters.endDate)) {
    throw new ValidationError("Custom range needs startDate and endDate (YYYY-MM-DD)");
  }

  const shop = await resolveShop(shopId);
  const range = buildPeriodRange(filters.period, filters.startDate, filters.endDate);
  const previous = previousPeriodRange(range);

  const [current, previousTotals, series, orders, lifetime] = await Promise.all([
    loadPeriodTotals(shop.addressId, range),
    previous ? loadPeriodTotals(shop.addressId, previous) : Promise.resolve(emptyTotals()),
    loadSeries(shop.addressId, range),
    loadOrders(shop.addressId, range, filters.page, filters.limit),
    loadPeriodTotals(shop.addressId, null),
  ]);

  let balances = null;
  let walletStatus = {
    loaded: false,
    hasOwner: Boolean(shop.agentUserId),
    error: null,
  };
  let lastEvents = {
    lastWithdrawAt: null,
    lastPayoutAt: null,
    lastCashRemittedAt: null,
  };
  let logs = {
    withdrawals: [],
    payouts: [],
    remittances: [],
  };
  let periodFinance = {
    withdrawn: 0,
    payoutsReleased: 0,
    cashRemitted: 0,
    pendingWithdrawals: 0,
  };

  if (shop.agentUserId) {
    try {
      const summary = await agentWalletService.getWalletSummary(shop.agentUserId);
      const rails = summary.rails || {};
      walletStatus = { loaded: true, hasOwner: true, error: null };
      balances = {
        totalEarnings: money(summary.totalEarning),
        totalEarningsCash: money(summary.totalEarningCash),
        totalEarningsCard: money(summary.totalEarningCard),
        availableWallet: money(summary.availableBalance),
        pendingWithdrawals: money(summary.pendingWithdrawals),
        withdrawnToBank: money(summary.totalWithdrawn),
        stillOwedByPlatform: money(summary.platformOwesAgent),
        releasedToWallet: money(summary.totalAgentPayouts),
        sittingInWallet: money(rails.payableToAgent?.sittingInWallet ?? summary.availableBalance),
        cashDueToPlatform: money(summary.cashDueToPlatform),
        cashPendingRemittance: money(summary.pendingCashRemittance),
        cashRemitted: money(summary.totalCashRemitted),
        cashInTill: money(rails.cashFromAgent?.cashInTill),
        connectAccountConnected: Boolean(summary.connectAccountConnected),
        canWithdraw: Boolean(summary.canWithdraw),
        minimumWithdrawal: summary.minimumWithdrawal ?? 1,
        currency: summary.currency || shop.currencyCode,
      };
      lastEvents = {
        lastWithdrawAt: await latestWalletAt(
          shop.agentUserId,
          agentWalletService.WITHDRAWAL_REFERENCE
        ),
        lastPayoutAt: summary.lastPayoutAt || rails.payableToAgent?.lastReleasedAt || null,
        lastCashRemittedAt:
          summary.lastCashRemittedAt || rails.cashFromAgent?.lastRemittedAt || null,
      };
      const [withdrawals, payouts, remittances, withdrawnInRange, payoutsInRange, remittedInRange] =
        await Promise.all([
          listWalletLogs(shop.agentUserId, agentWalletService.WITHDRAWAL_REFERENCE, range),
          listWalletLogs(shop.agentUserId, agentWalletService.AGENT_PAYOUT_REFERENCE, range),
          listWalletLogs(shop.agentUserId, agentWalletService.CASH_REMITTED_REFERENCE, range),
          periodWalletSum(
            shop.agentUserId,
            agentWalletService.WITHDRAWAL_REFERENCE,
            "debit",
            range
          ),
          periodWalletSum(
            shop.agentUserId,
            agentWalletService.AGENT_PAYOUT_REFERENCE,
            "credit",
            range
          ),
          periodWalletSum(
            shop.agentUserId,
            agentWalletService.CASH_REMITTED_REFERENCE,
            "credit",
            range
          ),
        ]);
      logs = { withdrawals, payouts, remittances };
      periodFinance = {
        withdrawn: withdrawnInRange,
        payoutsReleased: payoutsInRange,
        cashRemitted: remittedInRange,
        pendingWithdrawals: money(summary.pendingWithdrawals),
      };
    } catch (err) {
      walletStatus = {
        loaded: false,
        hasOwner: true,
        error: err.message || "Wallet summary failed",
      };
      console.warn(`[shop-revenue] wallet skipped for shop ${shop.businessInfoId}:`, err.message);
    }
  }

  return {
    shop: {
      id: shop.businessInfoId,
      name: shop.shopName,
      agentUserId: shop.agentUserId,
      addressId: shop.addressId,
      zoneId: shop.zoneId,
      zoneName: shop.zoneName,
    },
    currency: {
      code: shop.currencyCode,
      symbol: shop.currencySymbol,
    },
    filters: {
      period: filters.period,
      startDate: range ? toIsoDate(range.start) : null,
      endDate: range ? toIsoDate(range.end) : null,
      previousStartDate: previous ? toIsoDate(previous.start) : null,
      previousEndDate: previous ? toIsoDate(previous.end) : null,
    },
    lifetime: {
      ordersCompleted: lifetime.ordersCompleted,
      grossRevenue: lifetime.grossRevenue,
      shopNet: lifetime.shopNet,
      avgOrderValue: lifetime.avgOrderValue,
    },
    period: {
      ...current,
      vsPrevious: {
        grossRevenuePct: pctChange(current.grossRevenue, previousTotals.grossRevenue),
        shopNetPct: pctChange(current.shopNet, previousTotals.shopNet),
        ordersPct: pctChange(current.ordersCompleted, previousTotals.ordersCompleted),
        previousGrossRevenue: previousTotals.grossRevenue,
        previousShopNet: previousTotals.shopNet,
        previousOrders: previousTotals.ordersCompleted,
      },
    },
    periodFinance,
    series,
    balances,
    walletStatus,
    lastEvents,
    logs,
    orders: orders.rows,
    ordersPagination: orders.pagination,
    definitions: {
      grossRevenue:
        "Collected / completed bookings only (status Out for Delivery + Completed). Sum of invoice totals.",
      shopNet:
        "Shop share after platform commission and driver pay. Uses billed agent earning when present.",
      totalEarnings:
        "Lifetime shop commission credited on paid orders (card + cash channels), from the owner wallet summary.",
      lifetime:
        "All-time collected bookings for this shop address — independent of the selected period chips.",
      balances:
        "Live wallet rails — not filtered by the date chips. Date chips filter the logs and period totals.",
      withdrawn:
        "Agent Stripe Connect transfer. Admin payout only moves money into the wallet; it is not a bank payment.",
    },
  };
}

module.exports = {
  getShopRevenue,
  resolveShop,
};
