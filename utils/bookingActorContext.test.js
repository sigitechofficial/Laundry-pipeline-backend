'use strict';

const assert = require('assert');
const {
    actorFromUser,
    ACTOR_TYPES,
    actorLabel,
} = require('./bookingActorContext');
const { CLASSIFIED_AS, SYSTEM_ROLES } = require('../constants/systemRoles');
const {
    inferActorFromStatusId,
    presentLastStatusChange,
} = require('./bookingStatusChange');

assert.strictEqual(
    actorFromUser({ id: 9, classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE, roleId: SYSTEM_ROLES.LAUNDRY_SHOP_DRIVER }).type,
    ACTOR_TYPES.DRIVER
);
assert.strictEqual(
    actorFromUser({ id: 3, userTypeId: 3 }).type,
    ACTOR_TYPES.AGENT
);
assert.strictEqual(
    actorFromUser({ id: 1, classifiedAsId: CLASSIFIED_AS.ADMIN_EMPLOYEE }).type,
    ACTOR_TYPES.ADMIN
);
assert.strictEqual(actorFromUser({ id: 2, userTypeId: 2 }).type, ACTOR_TYPES.CUSTOMER);
assert.strictEqual(actorFromUser(null).type, ACTOR_TYPES.SYSTEM);
assert.strictEqual(actorLabel('driver'), 'Driver');

assert.strictEqual(inferActorFromStatusId(4), ACTOR_TYPES.DRIVER);
assert.strictEqual(inferActorFromStatusId(10), ACTOR_TYPES.AGENT);
assert.strictEqual(inferActorFromStatusId(1), ACTOR_TYPES.CUSTOMER);

const presented = presentLastStatusChange({
    history: {
        actorType: 'admin',
        actorFirstName: 'Ada',
        actorLastName: 'Admin',
        date: '2026-09-15',
        time: '15:13:00',
    },
    bookingStatusId: 11,
});
assert.strictEqual(presented.actorLabel, 'Admin');
assert.strictEqual(presented.actorName, 'Ada Admin');
assert.strictEqual(presented.inferred, false);
assert.ok(String(presented.at).includes('2026-09-15'));

const inferred = presentLastStatusChange({
    history: { date: '2026-09-14', time: '10:00:00', bookingStatusId: 8 },
    bookingStatusId: 8,
});
assert.strictEqual(inferred.actorType, ACTOR_TYPES.DRIVER);
assert.strictEqual(inferred.inferred, true);

const { runWithBookingActor, getBookingActor } = require('./bookingActorContext');
runWithBookingActor({ id: 4, classifiedAsId: CLASSIFIED_AS.ADMIN_EMPLOYEE }, () => {
    assert.strictEqual(getBookingActor().type, ACTOR_TYPES.ADMIN);
    assert.strictEqual(getBookingActor().userId, 4);
});
assert.strictEqual(getBookingActor().type, ACTOR_TYPES.SYSTEM);

console.log('bookingActorContext tests passed');
