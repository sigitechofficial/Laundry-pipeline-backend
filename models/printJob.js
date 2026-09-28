'use strict';

module.exports = (sequelize, DataTypes) => {
  const printJob = sequelize.define(
    'printJob',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      shopUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      bookingId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      kind: {
        type: DataTypes.STRING(16),
        allowNull: false,
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
      },
      requestedByUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      claimedByUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      channel: {
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      message: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      claimedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'print_jobs',
      timestamps: true,
    }
  );

  return printJob;
};
