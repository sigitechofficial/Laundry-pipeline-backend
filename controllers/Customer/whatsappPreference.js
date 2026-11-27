'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const whatsappService = require('../../services/whatsappService');

/** GET /customer/whatsapp-preference -> { whatsappUpdates: boolean } */
exports.getWhatsAppPreference = async (req, res) => {
    const optedOut = await whatsappService.isCustomerOptedOut(req.user.id);
    return ResponseHelper.success(res, 'WhatsApp preference', { whatsappUpdates: !optedOut });
};

/** PUT /customer/whatsapp-preference { whatsappUpdates: boolean } */
exports.updateWhatsAppPreference = async (req, res) => {
    const value = req.body?.whatsappUpdates;
    if (typeof value !== 'boolean') {
        throw new ValidationError('whatsappUpdates must be true or false');
    }
    await whatsappService.setCustomerOptOut(req.user.id, !value);
    return ResponseHelper.success(res, 'WhatsApp preference saved', { whatsappUpdates: value });
};
