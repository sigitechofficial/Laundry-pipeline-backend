'use strict';

const sequelizeLib = require('sequelize');
const { presentLastStatusChange } = require('./bookingStatusChange');

async function queryLatestStatusHistories(sequelize, ids, withActor) {
    const actorSelect = withActor
        ? `bh.actorType, bh.actorUserId,
           u.firstName AS actorFirstName, u.lastName AS actorLastName`
        : `NULL AS actorType, NULL AS actorUserId,
           NULL AS actorFirstName, NULL AS actorLastName`;
    const actorJoin = withActor
        ? 'LEFT JOIN users u ON u.id = bh.actorUserId'
        : '';
    return sequelize.query(
        `SELECT bh.id, bh.bookingId, bh.bookingStatusId, bh.date, bh.time, bh.createdAt,
                ${actorSelect}
         FROM bookingHistories bh
         INNER JOIN (
           SELECT bookingId, MAX(id) AS maxId
           FROM bookingHistories
           WHERE bookingId IN (:ids)
           GROUP BY bookingId
         ) latest ON latest.maxId = bh.id
         ${actorJoin}`,
        {
            replacements: { ids },
            type: sequelizeLib.QueryTypes.SELECT,
        }
    );
}

async function attachLastStatusChanges(sequelize, bookings) {
    if (!sequelize || !Array.isArray(bookings) || !bookings.length) return bookings;
    const ids = bookings.map((row) => Number(row.id)).filter((id) => id > 0);
    if (!ids.length) return bookings;

    let rows = [];
    try {
        rows = await queryLatestStatusHistories(sequelize, ids, true);
    } catch (actorErr) {
        try {
            rows = await queryLatestStatusHistories(sequelize, ids, false);
        } catch (err) {
            console.warn(
                '[attachLastStatusChanges] query skipped:',
                err?.message || actorErr?.message || err
            );
            rows = [];
        }
    }

    const byId = new Map();
    for (const row of rows) {
        byId.set(Number(row.bookingId), row);
    }
    for (const bookingRow of bookings) {
        bookingRow.lastStatusChange = presentLastStatusChange({
            history: byId.get(Number(bookingRow.id)) || null,
            bookingStatusId: bookingRow.bookingStatusId,
            bookingUpdatedAt: bookingRow.updatedAt,
        });
    }
    return bookings;
}

module.exports = {
    attachLastStatusChanges,
};
