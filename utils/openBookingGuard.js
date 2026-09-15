'use strict';

const {
    ISSUE_RESOLVED,
    TERMINAL_FOR_ACCOUNT_BLOCK,
} = require('../constants/bookingStatusIds');

const SHOP_ADDRESS_TYPE = 'LaundaryShopAddress';

function openCustomerBookingWhere(customerId, Op) {
    return {
        customerId: Number(customerId),
        bookingStatusId: { [Op.notIn]: TERMINAL_FOR_ACCOUNT_BLOCK },
    };
}

function openAssignedBookingWhere(userId, Op) {
    return {
        [Op.or]: [
            { driverId: Number(userId) },
            { deliveryDriverId: Number(userId) },
        ],
        bookingStatusId: { [Op.notIn]: TERMINAL_FOR_ACCOUNT_BLOCK },
    };
}

function openShopBookingWhere(shopAddressId, Op) {
    return {
        laundryShopId: Number(shopAddressId),
        bookingStatusId: { [Op.notIn]: TERMINAL_FOR_ACCOUNT_BLOCK },
    };
}

function openAgentOwnerBookingWhere(userId, shopAddressId, Op) {
    const or = [
        { driverId: Number(userId) },
        { deliveryDriverId: Number(userId) },
    ];
    if (shopAddressId) {
        or.push({ laundryShopId: Number(shopAddressId) });
    }
    return {
        [Op.or]: or,
        bookingStatusId: { [Op.notIn]: TERMINAL_FOR_ACCOUNT_BLOCK },
    };
}

module.exports = {
    ISSUE_RESOLVED,
    TERMINAL_FOR_ACCOUNT_BLOCK,
    SHOP_ADDRESS_TYPE,
    openCustomerBookingWhere,
    openAssignedBookingWhere,
    openShopBookingWhere,
    openAgentOwnerBookingWhere,
};
