'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/**
 * Physical shop visits: a Just Dry Cleans team member checks a shop in person
 * (cleanliness, machinery against what was registered, whether each service can
 * really be offered) and records remarks, a rating and a recommendation.
 * Optional: a shop can be approved without one.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'shopVisits')) return;
    await queryInterface.createTable('shopVisits', {
      id: { allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER },
      agentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        comment: 'users.id of the shop owner (agent)',
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      visitedAt: { type: Sequelize.DATE, allowNull: false, comment: 'When the visit took place' },
      visitedBy: { type: Sequelize.STRING(120), allowNull: false, comment: 'Team member who went to the shop' },
      recordedByAdminId: { type: Sequelize.INTEGER, allowNull: true, comment: 'Admin user who saved the report' },
      recordedByName: { type: Sequelize.STRING(120), allowNull: true },
      checklist: { type: Sequelize.JSON, allowNull: false, comment: '[{ key, question, result, remark }]' },
      services: { type: Sequelize.JSON, allowNull: false, comment: '[{ serviceId, name, canProvide, remark }]' },
      machinery: { type: Sequelize.JSON, allowNull: true, comment: '[{ name, registered, matches, condition, remark }]' },
      overallRating: { type: Sequelize.INTEGER, allowNull: true, comment: '1-5' },
      recommendation: { type: Sequelize.STRING(24), allowNull: false, comment: 'approve | needs_changes | reject' },
      feedback: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
      deletedAt: { allowNull: true, type: Sequelize.DATE },
    });
    await queryInterface.addIndex('shopVisits', ['agentId', 'visitedAt']);
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'shopVisits')) {
      await queryInterface.dropTable('shopVisits');
    }
  },
};
