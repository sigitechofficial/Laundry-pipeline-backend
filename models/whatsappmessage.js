'use strict';
const { Model } = require('sequelize');

/** One automatic WhatsApp message to a customer (see services/whatsappService.js). */
module.exports = (sequelize, DataTypes) => {
    class whatsappMessage extends Model {
        static associate(models) {
            whatsappMessage.belongsTo(models.booking, { foreignKey: 'bookingId', as: 'booking' });
        }
    }
    whatsappMessage.init(
        {
            bookingId: { type: DataTypes.INTEGER, allowNull: false },
            customerId: { type: DataTypes.INTEGER, allowNull: true },
            event: { type: DataTypes.STRING(40), allowNull: false },
            dedupeKey: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
            toMasked: { type: DataTypes.STRING(32), allowNull: true },
            templateSid: { type: DataTypes.STRING(64), allowNull: true },
            twilioSid: { type: DataTypes.STRING(64), allowNull: true },
            status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'queued' },
            error: { type: DataTypes.STRING(255), allowNull: true },
            sentAt: { type: DataTypes.DATE, allowNull: true },
            deliveredAt: { type: DataTypes.DATE, allowNull: true },
        },
        { sequelize, modelName: 'whatsappMessage', tableName: 'whatsappMessages' }
    );
    return whatsappMessage;
};
