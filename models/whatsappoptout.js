'use strict';
const { Model } = require('sequelize');

/** A customer who does not want automatic WhatsApp messages. */
module.exports = (sequelize, DataTypes) => {
    class whatsappOptOut extends Model {}
    whatsappOptOut.init(
        { userId: { type: DataTypes.INTEGER, allowNull: false, unique: true } },
        { sequelize, modelName: 'whatsappOptOut', tableName: 'whatsappOptOuts' }
    );
    return whatsappOptOut;
};
