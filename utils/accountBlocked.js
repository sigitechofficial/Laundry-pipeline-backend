'use strict';

/**
 * Stable contract when admin has blocked a customer or agent.
 * Login, JWT middleware, and create-booking all use the same code + copy so
 * apps can toast once and refuse to proceed.
 */
const ACCOUNT_BLOCKED_CODE = 'ACCOUNT_BLOCKED';
const ACCOUNT_BLOCKED_MESSAGE =
    'You are blocked from admin. Contact the support team.';

function isUserBlocked(status) {
    return status === false || status === 0 || status === '0';
}

function accountBlockedBody() {
    return {
        status: '0',
        code: ACCOUNT_BLOCKED_CODE,
        message: ACCOUNT_BLOCKED_MESSAGE,
        data: { code: ACCOUNT_BLOCKED_CODE },
        error: ACCOUNT_BLOCKED_CODE,
    };
}

function looksLikeAccountBlockedPayload(body) {
    if (!body || typeof body !== 'object') return false;
    const code = body.code || body.error || (body.data && body.data.code);
    if (code === ACCOUNT_BLOCKED_CODE) return true;
    const message = String(body.message || '').toLowerCase();
    return message.includes('blocked from admin');
}

module.exports = {
    ACCOUNT_BLOCKED_CODE,
    ACCOUNT_BLOCKED_MESSAGE,
    isUserBlocked,
    accountBlockedBody,
    looksLikeAccountBlockedPayload,
};
