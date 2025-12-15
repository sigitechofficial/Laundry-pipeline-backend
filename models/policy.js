'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class policy extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // Relation with NoShowPolicyConfig Model
      policy.hasOne(models.noShowPolicyConfig)
      models.noShowPolicyConfig.belongsTo(policy)
      
      // Relation with CancellationPolicyConfig Model
      policy.hasOne(models.cancellationPolicyConfig, {
        foreignKey: 'policyId',
        as: 'cancellationConfig'
      })
      models.cancellationPolicyConfig.belongsTo(policy)
    }
  }
  policy.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    type: {
      type: DataTypes.ENUM('no_show', 'cancellation', 'late_pickup', 'late_delivery'),
      allowNull: false,
      defaultValue: 'no_show'
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    isDefault: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    updatedBy: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'policy',
    tableName: 'policies',
    timestamps: true,
    paranoid: true
  });
  return policy;
};