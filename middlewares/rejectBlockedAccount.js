'use strict';

const { users } = require('../models');
const {
    isUserBlocked,
    accountBlockedBody,
} = require('../utils/accountBlocked');

/**
 * After JWT is valid, refuse the request if admin has blocked the user.
 * Redis logout is not enough: a still-logged-in app must fail closed.
 * @returns {Promise<boolean>} true if the response was already sent
 */
async function sendIfAccountBlocked(userId, res) {
    const id = Number(userId);
    if (!Number.isFinite(id) || id <= 0) return false;

    const user = await users.findByPk(id, { attributes: ['id', 'status'] });
    if (!user || !isUserBlocked(user.status)) return false;

    res.status(403).json(accountBlockedBody());
    return true;
}

module.exports = { sendIfAccountBlocked };
