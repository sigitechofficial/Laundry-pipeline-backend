"use strict";

const { money } = require("../services/Admin/shopRevenuePeriod");
const { customersWhoUsedBoth } = require("./earningChannel");

function emptyChannelMoney() {
  return {
    orders: 0,
    customers: 0,
    gross: 0,
    laundry: 0,
    serviceFee: 0,
    platformCommission: 0,
    platformTake: 0,
    shopNet: 0,
  };
}

function emptySettlementReport() {
  return {
    ordersPaid: 0,
    customers: 0,
    customersWhoUsedBoth: 0,
    laundry: 0,
    serviceFee: 0,
    platformCommission: 0,
    platformTake: 0,
    shopNet: 0,
    driverEarnings: 0,
    discount: 0,
    gross: 0,
    card: emptyChannelMoney(),
    cash: emptyChannelMoney(),
    mixed: emptyChannelMoney(),
  };
}

function channelFrom(row, prefix) {
  return {
    orders: Number(row[`${prefix}Orders`] || 0),
    customers: Number(row[`${prefix}Customers`] || 0),
    gross: money(row[`${prefix}Gross`]),
    laundry: money(row[`${prefix}Laundry`]),
    serviceFee: money(row[`${prefix}ServiceFee`]),
    platformCommission: money(row[`${prefix}Commission`]),
    platformTake: money(row[`${prefix}PlatformTake`]),
    shopNet: money(row[`${prefix}ShopNet`]),
  };
}

function mapSettlementReport(row) {
  if (!row) return emptySettlementReport();
  const cash = channelFrom(row, "cash");
  const card = channelFrom(row, "card");
  const mixed = channelFrom(row, "mixed");
  const customers = Number(row.customers || 0);
  return {
    ordersPaid: Number(row.ordersPaid || 0),
    customers,
    customersWhoUsedBoth: customersWhoUsedBoth(
      cash.customers,
      card.customers,
      customers
    ),
    laundry: money(row.laundry),
    serviceFee: money(row.serviceFee),
    platformCommission: money(row.platformCommission),
    platformTake: money(row.platformTake),
    shopNet: money(row.shopNet),
    driverEarnings: money(row.driverEarnings),
    discount: money(row.discount),
    gross: money(row.gross),
    card,
    cash,
    mixed,
  };
}

module.exports = {
  emptyChannelMoney,
  emptySettlementReport,
  mapSettlementReport,
};
