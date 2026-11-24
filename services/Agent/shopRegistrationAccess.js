'use strict';

/**
 * Which shop a shop-registration write (address, business information, services,
 * working hours) is for, and whether the caller may write it.
 *
 * Signed in (accessTokenIfPresent verified a session): the caller's own shop. Only
 * the shop owner sets the shop up; a body / path `userId` that names another account
 * is refused rather than silently replaced. Sessions exist throughout registration:
 * sign-up (POST /agent/registerAgent) opens one, and a password-checked sign-in of a
 * shop whose set-up is unfinished returns one with its "address missing" /
 * "business information missing" answer (services/Agent/authService.js loginUser).
 *
 * No session (LEGACY): app builds released before the registration session sent
 * these writes without one (only the sign-up path's address call carried it), with
 * the shop named by a client-sent `userId`. They keep working, with the tightest
 * check that can be made without proof of the account:
 *   - the account is a verified, active, not deleted shop OWNER account;
 *   - `incompleteSetupOnly` writes (business information, services) are accepted
 *     only while the shop's set-up is unfinished, i.e. while that shop cannot sign
 *     in yet; a live shop's details can no longer be changed anonymously;
 *   - the address write is accepted only while the shop has no address (checked by
 *     the handler, which refuses a second address for everyone).
 * Working hours stay open to anonymous callers for any verified owner: installed
 * builds also save them from Profile without a session. Set
 * SHOP_REGISTRATION_ALLOW_ANONYMOUS=false once the minimum supported app version
 * sends the session, and every one of these writes requires it.
 *
 * Every anonymous refusal has the same answer, so it does not tell a caller which
 * account ids exist or how far their set-up is.
 */

const { Op } = require('sequelize');
const { ForbiddenError, UnauthorizedError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { isShopOwner } = require('../../utils/shopAgentContext');

const SHOP_OWNER_USER_TYPE_ID = 4;
const ANONYMOUS_REFUSED = 'Sign in to continue setting up your shop';

/** Whether requests without a session are still served (LEGACY builds). Default: yes. */
function anonymousRegistrationAllowed(env = process.env) {
    return String(env.SHOP_REGISTRATION_ALLOW_ANONYMOUS ?? 'true').trim().toLowerCase() !== 'false';
}

function positiveId(value) {
    if (value === undefined || value === null || value === '') return null;
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : NaN;
}

/**
 * @param {object} deps
 * @param {object} deps.models  users, bussinessInformation, agentSelectServices
 * @param {object} [deps.env]
 */
function createShopRegistrationAccess({ models, env = process.env }) {
    const { users, bussinessInformation, agentSelectServices } = models;

    /** Same rule as the sign-in refusal "Please complete your information before logging in". */
    async function setupComplete(shopId) {
        const info = await bussinessInformation.findOne({
            where: { agentId: shopId },
            attributes: ['id', 'shopName', 'matchProfileOptions'],
        });
        if (!info || !info.shopName || !info.matchProfileOptions) return false;
        const services = await agentSelectServices.findOne({
            where: { agentServiceId: shopId },
            attributes: ['id'],
        });
        return Boolean(services);
    }

    async function anonymousShopId(legacyUserId, { incompleteSetupOnly }) {
        if (!anonymousRegistrationAllowed(env)) throw new UnauthorizedError(ANONYMOUS_REFUSED);
        const id = positiveId(legacyUserId);
        if (id === null || Number.isNaN(id)) throw new ValidationError('userId must be a positive integer');

        const account = await users.findOne({
            where: { id, userTypeId: SHOP_OWNER_USER_TYPE_ID, deletedAt: { [Op.is]: null } },
            attributes: ['id', 'classifiedAsId', 'verifiedAt', 'status'],
        });
        const ownerAccount = account && (account.classifiedAsId === null || account.classifiedAsId === undefined);
        if (!ownerAccount || !account.verifiedAt || !account.status) {
            throw new UnauthorizedError(ANONYMOUS_REFUSED);
        }
        if (incompleteSetupOnly && await setupComplete(id)) {
            throw new UnauthorizedError(ANONYMOUS_REFUSED);
        }
        return id;
    }

    /**
     * @param {import('express').Request} req after accessTokenIfPresent
     * @param {object} options
     * @param {*} options.legacyUserId  the client-sent shop id (body or path), if any
     * @param {boolean} [options.incompleteSetupOnly]  anonymous: only while set-up is unfinished
     * @returns {Promise<number>} the shop owner's user id to write for
     */
    async function registrationShopId(req, { legacyUserId, incompleteSetupOnly = false } = {}) {
        if (!req.user) return anonymousShopId(legacyUserId, { incompleteSetupOnly });

        if (!isShopOwner(req.user)) {
            throw new ForbiddenError('Only the shop owner can change the shop set-up');
        }
        const sessionId = Number(req.user.id);
        const named = positiveId(legacyUserId);
        if (named !== null && named !== sessionId) {
            throw new ForbiddenError('You can only set up your own shop');
        }
        return sessionId;
    }

    return { registrationShopId, setupComplete };
}

let defaultAccess;
/** The access check over the real models (loaded on first use). */
function shopRegistrationAccess() {
    if (!defaultAccess) defaultAccess = createShopRegistrationAccess({ models: require('../../models') });
    return defaultAccess;
}

module.exports = {
    createShopRegistrationAccess,
    shopRegistrationAccess,
    anonymousRegistrationAllowed,
    ANONYMOUS_REFUSED,
};
