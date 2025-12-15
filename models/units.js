'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class units extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // Linking as weightUnit with appUnit model
      units.hasMany(models.appUnits, { as: 'weightUnit', foreignKey: 'weightUnitId' })
      models.appUnits.belongsTo(units, { as: 'weightUnit', foreignKey: 'weightUnitId' })
      // Linking as lengthUnit with appUnit model
      units.hasMany(models.appUnits, { as: 'lengthUnit', foreignKey: 'lengthUnitId' })
      models.appUnits.belongsTo(units, { as: 'lengthUnit', foreignKey: 'lengthUnitId' })
      // Linking as DistanceUnit with appUnit
      units.hasMany(models.appUnits, { as: 'distanceUnit', foreignKey: 'distanceUnitId' });
      models.appUnits.belongsTo(units, { as: 'distanceUnit', foreignKey: 'distanceUnitId' });
      // Linking as currencyUnit with appUnit
      units.hasMany(models.appUnits, { as: 'currencyUnit', foreignKey: 'currencyUnitId' });
      models.appUnits.belongsTo(units, { as: 'currencyUnit', foreignKey: 'currencyUnitId' });

      // Linking as weightUnitB with appUnit model
      units.hasMany(models.baseUnits, { as: 'weightUnitB', foreignKey: 'weightUnitId' });
      models.baseUnits.belongsTo(units, { as: 'weightUnitB', foreignKey: 'weightUnitId' });
      // Linking as lengthUnitB with appUnit model
      units.hasMany(models.baseUnits, { as: 'lengthUnitB', foreignKey: 'lengthUnitId' });
      models.baseUnits.belongsTo(units, { as: 'lengthUnitB', foreignKey: 'lengthUnitId' });
      // Linking as distanceUnitB with appUnit model
      units.hasMany(models.baseUnits, { as: 'distanceUnitB', foreignKey: 'distanceUnitId' });
      models.baseUnits.belongsTo(units, { as: 'distanceUnitB', foreignKey: 'distanceUnitId' });

      // Linking as currencyUnitB with appUnit model
      units.hasMany(models.baseUnits, { as: 'currencyUnitB', foreignKey: 'currencyUnitId' });
      models.baseUnits.belongsTo(units, { as: 'currencyUnitB', foreignKey: 'currencyUnitId' });

      //Linking with model zone
      units.hasMany(models.zone, { as: 'distanceUnitZ', foreignKey: "distanceUnitId" })
      models.zone.belongsTo(units, { as: 'distanceUnitZ', foreignKey: "distanceUnitId" })

      // Linking as currencyUnitZ with zone model
      units.hasMany(models.zone, { as: 'currencyUnitZ', foreignKey: 'currencyUnitId' });
      models.zone.belongsTo(units, { as: 'currencyUnitZ', foreignKey: 'currencyUnitId' });




    }
  }
  units.init({
    type: {
      type: DataTypes.STRING,
      allowNull: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true
    },
    symbol: {
      type: DataTypes.STRING,
      allowNull: true
    },
    desc: {
      type: DataTypes.STRING,
      allowNull: true
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true
    },
    conversionRate: {
      type: DataTypes.DECIMAL(8, 4),
      allowNull: true
    },
    deleted: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false }
  }, {
    sequelize,
    modelName: 'units',
  });
  return units;
};