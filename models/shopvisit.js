'use strict';

const { jsonColumn } = require('../utils/jsonColumn');

/** Physical shop visit report — see migrations/20261126120000-create-shop-visits.js. */
module.exports = (sequelize, DataTypes) => {
  const shopVisit = sequelize.define(
    'shopVisit',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      agentId: { type: DataTypes.INTEGER, allowNull: false },
      visitedAt: { type: DataTypes.DATE, allowNull: false },
      visitedBy: { type: DataTypes.STRING(120), allowNull: false },
      recordedByAdminId: { type: DataTypes.INTEGER, allowNull: true },
      recordedByName: { type: DataTypes.STRING(120), allowNull: true },
      checklist: jsonColumn(DataTypes, 'checklist', { allowNull: false }),
      services: jsonColumn(DataTypes, 'services', { allowNull: false }),
      machinery: jsonColumn(DataTypes, 'machinery', { allowNull: true }),
      overallRating: { type: DataTypes.INTEGER, allowNull: true },
      recommendation: { type: DataTypes.STRING(24), allowNull: false },
      feedback: { type: DataTypes.TEXT, allowNull: true },
    },
    { tableName: 'shopVisits', paranoid: true }
  );
  return shopVisit;
};
