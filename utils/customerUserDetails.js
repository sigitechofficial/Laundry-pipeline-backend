'use strict';

const { isUserBlocked } = require('./accountBlocked');

/**
 * Customer detail payload is an address row with a nested `user`.
 * The address include historically omitted `users.status`, so admin Block/Unblock
 * reset on refresh even though login was correctly refused.
 * Always overlay the customer record (source of truth for account status).
 * Do not overwrite address `status` — that is the address row flag.
 */
function presentCustomerUserDetails(customer, addressRow) {
    const customerJson = customer && typeof customer.toJSON === 'function'
        ? customer.toJSON()
        : { ...(customer || {}) };
    const blocked = isUserBlocked(customerJson.status);
    const userDetails = addressRow
        ? (typeof addressRow.toJSON === 'function' ? addressRow.toJSON() : { ...addressRow })
        : {};
    const nestedAddressUser =
        userDetails.user && typeof userDetails.user === 'object' ? userDetails.user : {};

    userDetails.userId = customerJson.id;
    userDetails.user = {
        ...nestedAddressUser,
        ...customerJson,
        status: customerJson.status,
        blocked,
    };
    userDetails.blocked = blocked;
    return userDetails;
}

module.exports = {
    presentCustomerUserDetails,
};
