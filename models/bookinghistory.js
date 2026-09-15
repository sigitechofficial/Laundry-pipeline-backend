'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class bookingHistory extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      bookingHistory.belongsTo(models.users, {
        as: 'actor',
        foreignKey: 'actorUserId',
      });
    }
  }
  bookingHistory.init({
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    time: {
      type: DataTypes.TIME,
      allowNull: false
    },
    bookingId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    bookingStatusId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    actorType: {
      type: DataTypes.STRING(16),
      allowNull: true
    },
    actorUserId: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'bookingHistory',
  });

  bookingHistory.addHook('beforeCreate', (row) => {
    if (row.actorType) return;
    try {
      const { getBookingActor } = require('../utils/bookingActorContext');
      const actor = getBookingActor();
      if (!actor) return;
      row.actorType = actor.type;
      if (actor.userId != null && row.actorUserId == null) {
        row.actorUserId = actor.userId;
      }
    } catch (_err) {
      // Never block a status write if actor context is unavailable.
    }
  });

  return bookingHistory;
};