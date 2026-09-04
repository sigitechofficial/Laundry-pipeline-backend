'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

module.exports = {
    async up(queryInterface, Sequelize) {
        await addColumnIfMissing(queryInterface, 'tips', 'source', {
            type: Sequelize.STRING(32),
            allowNull: false,
            defaultValue: 'booking',
        });
        await addColumnIfMissing(queryInterface, 'tips', 'paymentType', {
            type: Sequelize.STRING(16),
            allowNull: true,
            defaultValue: null,
        });
        await addColumnIfMissing(queryInterface, 'tips', 'stripePaymentIntentId', {
            type: Sequelize.STRING(64),
            allowNull: true,
            defaultValue: null,
        });
        await addColumnIfMissing(queryInterface, 'tips', 'paidAt', {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
        });
        await addColumnIfMissing(queryInterface, 'tips', 'createdByUserId', {
            type: Sequelize.INTEGER,
            allowNull: true,
            defaultValue: null,
        });
    },

    async down(queryInterface) {
        await removeColumnIfExists(queryInterface, 'tips', 'createdByUserId');
        await removeColumnIfExists(queryInterface, 'tips', 'paidAt');
        await removeColumnIfExists(queryInterface, 'tips', 'stripePaymentIntentId');
        await removeColumnIfExists(queryInterface, 'tips', 'paymentType');
        await removeColumnIfExists(queryInterface, 'tips', 'source');
    },
};
