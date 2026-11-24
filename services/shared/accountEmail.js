'use strict';

/**
 * Who owns an email address.
 *
 * `users.email` is UNIQUE across every kind of account — customers (userTypeId 2), shop owners
 * (4), drivers (3), admins (1) and shop / admin staff (classifiedAsId 1 / 2, no userTypeId) —
 * and soft-deleted rows keep theirs (paranoid model). Every sign-up, social sign-in and create
 * path asks this module before it writes, so an address that belongs to another kind of account
 * (or to a deleted account) is refused with a clear 409 instead of
 *  - failing on the unique index (SequelizeUniqueConstraintError → 500), or
 *  - being treated as the caller's own account and having its profile / password overwritten.
 * A path only ever updates a row of its own kind.
 */

const { ConflictError } = require('../../middlewares/universalErrorHandler');
const { CLASSIFIED_AS } = require('../../constants/systemRoles');

const USER_TYPE = Object.freeze({ ADMIN: 1, CUSTOMER: 2, DRIVER: 3, AGENT: 4 });

const ACCOUNT_KIND = Object.freeze({
    CUSTOMER: 'customer',
    SHOP: 'shop',
    DRIVER: 'driver',
    SHOP_STAFF: 'shop_staff',
    STAFF: 'staff',
});

const EMAIL_IN_USE_CODE = 'EMAIL_IN_USE';

const OWNER_PHRASE = Object.freeze({
    [ACCOUNT_KIND.CUSTOMER]: 'is already registered as a customer account',
    [ACCOUNT_KIND.SHOP]: 'is already used by a shop account',
    [ACCOUNT_KIND.DRIVER]: 'is already used by a driver account',
    [ACCOUNT_KIND.SHOP_STAFF]: 'is already used by a shop team member account',
    [ACCOUNT_KIND.STAFF]: 'is already used by a staff account',
});

const ACCOUNT_NOUN = Object.freeze({
    [ACCOUNT_KIND.CUSTOMER]: 'customer',
    [ACCOUNT_KIND.SHOP]: 'shop',
    [ACCOUNT_KIND.DRIVER]: 'driver',
    [ACCOUNT_KIND.SHOP_STAFF]: 'team member',
    [ACCOUNT_KIND.STAFF]: 'staff',
});

const OWNER_ATTRIBUTES = ['id', 'email', 'userTypeId', 'classifiedAsId', 'verifiedAt', 'deletedAt', 'signedFrom'];

/** The kind of account a users row is. */
function accountKindOf(row) {
    switch (Number(row.userTypeId)) {
        case USER_TYPE.CUSTOMER: return ACCOUNT_KIND.CUSTOMER;
        case USER_TYPE.AGENT: return ACCOUNT_KIND.SHOP;
        case USER_TYPE.DRIVER: return ACCOUNT_KIND.DRIVER;
        case USER_TYPE.ADMIN: return ACCOUNT_KIND.STAFF;
        default:
            return Number(row.classifiedAsId) === CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE
                ? ACCOUNT_KIND.SHOP_STAFF
                : ACCOUNT_KIND.STAFF;
    }
}

/**
 * The 409 for an email `owner` holds, worded for someone creating a `forKind` account.
 * @param {object} owner users row (OWNER_ATTRIBUTES)
 * @param {string} forKind ACCOUNT_KIND of the account being created / signed in
 */
function emailInUseError(owner, forKind) {
    const ownerKind = accountKindOf(owner);
    let message;
    if (owner.deletedAt) {
        message = 'This email belongs to a deleted account and cannot be used again. Please use a different email.';
    } else if (ownerKind === forKind) {
        message = 'An account with this email already exists. Please use a different email.';
    } else {
        message = `This email ${OWNER_PHRASE[ownerKind]}. Please use a different email for your ${ACCOUNT_NOUN[forKind]} account.`;
    }
    return new ConflictError(message, { code: EMAIL_IN_USE_CODE });
}

/**
 * The users row holding `email`, deleted rows included; null when the address is free.
 * @param {{ findOne: Function }} users the users model
 */
async function findEmailOwner(users, email, { transaction } = {}) {
    if (typeof email !== 'string' || !email.trim()) return null;
    return users.findOne({
        where: { email },
        paranoid: false,
        attributes: OWNER_ATTRIBUTES,
        ...(transaction ? { transaction } : {}),
    });
}

/**
 * For a path that serves one user type: the live row of that type holding `email` (the caller's
 * own account), null when the address is free.
 * @throws {ConflictError} 409 EMAIL_IN_USE when another kind of account or a deleted account has it
 */
async function ownAccountForEmail(users, email, userTypeId, forKind, options) {
    const owner = await findEmailOwner(users, email, options);
    if (!owner) return null;
    if (!owner.deletedAt && Number(owner.userTypeId) === Number(userTypeId)) return owner;
    throw emailInUseError(owner, forKind);
}

/**
 * For a path that only creates: the address must be free.
 * @throws {ConflictError} 409 EMAIL_IN_USE when any account (deleted included) has it
 */
async function assertEmailFree(users, email, forKind, options) {
    const owner = await findEmailOwner(users, email, options);
    if (owner) throw emailInUseError(owner, forKind);
}

module.exports = {
    USER_TYPE,
    ACCOUNT_KIND,
    EMAIL_IN_USE_CODE,
    accountKindOf,
    emailInUseError,
    findEmailOwner,
    ownAccountForEmail,
    assertEmailFree,
};
