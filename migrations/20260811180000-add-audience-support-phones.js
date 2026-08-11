'use strict';

const { addColumnIfMissing } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'support_contact_configs', 'agentSupportPhone', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: 'Phone agents dial for admin/support (falls back to supportPhone)',
    });
    await addColumnIfMissing(queryInterface, 'support_contact_configs', 'customerSupportPhone', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: 'Phone customers dial for support (falls back to supportPhone)',
    });

    await addColumnIfMissing(queryInterface, 'zones', 'agentSupportPhone', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: 'Optional zone override for agent → admin support phone',
    });
    await addColumnIfMissing(queryInterface, 'zones', 'customerSupportPhone', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: 'Optional zone override for customer → support phone',
    });

    // Backfill audience phones from existing supportPhone when empty.
    await queryInterface.sequelize.query(`
      UPDATE support_contact_configs
      SET
        agentSupportPhone = COALESCE(NULLIF(TRIM(agentSupportPhone), ''), supportPhone),
        customerSupportPhone = COALESCE(NULLIF(TRIM(customerSupportPhone), ''), supportPhone)
      WHERE supportPhone IS NOT NULL AND TRIM(supportPhone) <> ''
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('zones', 'customerSupportPhone').catch(() => {});
    await queryInterface.removeColumn('zones', 'agentSupportPhone').catch(() => {});
    await queryInterface.removeColumn('support_contact_configs', 'customerSupportPhone').catch(() => {});
    await queryInterface.removeColumn('support_contact_configs', 'agentSupportPhone').catch(() => {});
  },
};
