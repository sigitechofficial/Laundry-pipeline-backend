'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const {
    isShopDriver,
    isShopEmployee,
    isShopManager,
} = require('./shopAgentContext');
const { CLASSIFIED_AS } = require('../constants/systemRoles');

const ACTOR_TYPES = Object.freeze({
    ADMIN: 'admin',
    AGENT: 'agent',
    DRIVER: 'driver',
    CUSTOMER: 'customer',
    SYSTEM: 'system',
});

const ACTOR_LABELS = Object.freeze({
    admin: 'Admin',
    agent: 'Agent',
    driver: 'Driver',
    customer: 'Customer',
    system: 'System',
});

const als = new AsyncLocalStorage();

function actorFromUser(user) {
    if (!user || user.guest) {
        return { type: ACTOR_TYPES.SYSTEM, userId: null };
    }
    const userId = user.id != null ? Number(user.id) : null;
    const id = Number.isFinite(userId) && userId > 0 ? userId : null;

    if (isShopDriver(user)) return { type: ACTOR_TYPES.DRIVER, userId: id };
    if (isShopManager(user) || isShopEmployee(user)) {
        return { type: ACTOR_TYPES.AGENT, userId: id };
    }
    if (Number(user.classifiedAsId) === CLASSIFIED_AS.ADMIN_EMPLOYEE) {
        return { type: ACTOR_TYPES.ADMIN, userId: id };
    }
    if (Number(user.userTypeId) === 2) return { type: ACTOR_TYPES.CUSTOMER, userId: id };
    if (Number(user.userTypeId) === 3) return { type: ACTOR_TYPES.AGENT, userId: id };
    return { type: ACTOR_TYPES.ADMIN, userId: id };
}

function enterBookingActor(user) {
    als.enterWith(actorFromUser(user));
}

function runWithBookingActor(user, fn) {
    return als.run(actorFromUser(user), fn);
}

function getBookingActor() {
    return als.getStore() || { type: ACTOR_TYPES.SYSTEM, userId: null };
}

function actorLabel(type) {
    return ACTOR_LABELS[type] || ACTOR_LABELS.system;
}

module.exports = {
    ACTOR_TYPES,
    ACTOR_LABELS,
    actorFromUser,
    enterBookingActor,
    runWithBookingActor,
    getBookingActor,
    actorLabel,
};
