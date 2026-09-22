'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../utils/migrationHelpers');

/**
 * Shop-profile / settings fields edited from the admin shop-detail Settings tab
 * (PATCH /admin/updateLaundryShop/:id). These had no columns, so saving 404'd /
 * dropped the values. All nullable, idempotent.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        await addColumnIfMissing(queryInterface, 'bussinessInformations', 'website', {
            type: Sequelize.STRING(255),
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, 'bussinessInformations', 'description', {
            type: Sequelize.TEXT,
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, 'bussinessInformations', 'adminNotes', {
            type: Sequelize.STRING(1000),
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, 'bussinessInformations', 'collectionMethod', {
            type: Sequelize.STRING(64),
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, 'bussinessInformations', 'deliveryMethod', {
            type: Sequelize.STRING(64),
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, 'bussinessInformations', 'leadTimeHours', {
            type: Sequelize.INTEGER,
            allowNull: true,
        });
        await addColumnIfMissing(queryInterface, 'bussinessInformations', 'maxActiveOrders', {
            type: Sequelize.INTEGER,
            allowNull: true,
        });
    },

    async down(queryInterface) {
        for (const col of [
            'website',
            'description',
            'adminNotes',
            'collectionMethod',
            'deliveryMethod',
            'leadTimeHours',
            'maxActiveOrders',
        ]) {
            await removeColumnIfExists(queryInterface, 'bussinessInformations', col);
        }
    },
};
