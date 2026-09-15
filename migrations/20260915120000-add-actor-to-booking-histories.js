'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/** Who last wrote a bookingHistories row (admin / agent / driver / customer / system). */
module.exports = {
    async up(queryInterface, Sequelize) {
        await addColumnIfMissing(queryInterface, 'bookingHistories', 'actorType', {
            type: Sequelize.STRING(16),
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, 'bookingHistories', 'actorUserId', {
            type: Sequelize.INTEGER,
            allowNull: true,
        });
    },

    async down(queryInterface) {
        await removeColumnIfExists(queryInterface, 'bookingHistories', 'actorUserId');
        await removeColumnIfExists(queryInterface, 'bookingHistories', 'actorType');
    },
};
