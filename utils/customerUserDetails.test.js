'use strict';

const assert = require('assert');
const { presentCustomerUserDetails } = require('./customerUserDetails');

const customer = {
    id: 376,
    firstName: 'sep',
    lastName: 'customer',
    email: 'muzna14@gmail.com',
    phoneNum: '6464658836',
    status: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    toJSON() {
        return {
            id: this.id,
            firstName: this.firstName,
            lastName: this.lastName,
            email: this.email,
            phoneNum: this.phoneNum,
            status: this.status,
            createdAt: this.createdAt,
        };
    },
};

const address = {
    id: 12,
    title: 'Home',
    streetAddress: 'Golders Green Road',
    status: true,
    userId: 376,
    user: {
        id: 376,
        firstName: 'sep',
        lastName: 'customer',
        email: 'muzna14@gmail.com',
        phoneNum: '6464658836',
    },
    toJSON() {
        return {
            id: this.id,
            title: this.title,
            streetAddress: this.streetAddress,
            status: this.status,
            userId: this.userId,
            user: { ...this.user },
        };
    },
};

const withAddress = presentCustomerUserDetails(customer, address);
assert.strictEqual(withAddress.user.status, false);
assert.strictEqual(withAddress.user.blocked, true);
assert.strictEqual(withAddress.blocked, true);
assert.strictEqual(withAddress.status, true, 'address status must stay on the address row');
assert.strictEqual(withAddress.user.email, 'muzna14@gmail.com');
assert.strictEqual(withAddress.userId, 376);

const noAddress = presentCustomerUserDetails(customer, null);
assert.strictEqual(noAddress.user.status, false);
assert.strictEqual(noAddress.blocked, true);
assert.strictEqual(noAddress.userId, 376);

const activeCustomer = presentCustomerUserDetails({ id: 1, status: true }, null);
assert.strictEqual(activeCustomer.blocked, false);
assert.strictEqual(activeCustomer.user.status, true);

console.log('customerUserDetails tests passed');
