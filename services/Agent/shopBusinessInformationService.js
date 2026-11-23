'use strict';

/**
 * A shop's business information and working hours, read for one shop owner id.
 *
 * Callers decide whose shop it is; this service never takes an id from a request:
 *   - the agent app: the signed-in caller's own shop (shopAgentIdFromReq: an
 *     employee resolves to employeeOff), see controllers/Agent/shopBusinessInfoController.js
 *   - the admin portal: any shop, after the admin's permission and zone checks,
 *     see controllers/Admin/shopBusinessInformationController.js
 */

const {
    machines,
    agentSelectServices,
    service,
    users,
    bussinessWorkingHours,
} = require('../../models');
const { getCountryContextFromShopUserId } = require('../../utils/countryTimeZone');
const platformOperationalHoursService = require('../Admin/platformOperationalHoursService');

/**
 * Machine catalog and the services the shop offers.
 * @param {number} shopOwnerId
 */
async function getBusinessInformation(shopOwnerId) {
    const allMachineInformation = await machines.findAll();
    const agentServices = await agentSelectServices.findAll({
        where: { agentServiceId: shopOwnerId, status: true },
        include: [
            { model: service, attributes: ['id', 'name'] },
            { model: users, as: 'agentServices', attributes: ['firstName', 'lastName', 'email'] },
        ],
        attributes: ['id', 'status'],
    });
    return { allMachineInformation, agentServices };
}

/**
 * Platform opening-hour bounds of the shop's country. The country comes from the
 * shop's address (strict: a shop without one is a 422, never a default country).
 * @param {number} shopOwnerId
 */
async function getPlatformOperationalHours(shopOwnerId) {
    const { countryId } = await getCountryContextFromShopUserId(shopOwnerId);
    return platformOperationalHoursService.getAll(countryId);
}

/**
 * The shop's own working hours plus its country's platform bounds.
 * @param {number} shopOwnerId
 */
async function getWorkingHours(shopOwnerId) {
    const platformOperationalHours = await getPlatformOperationalHours(shopOwnerId);
    const bussinesWorkingHours = await bussinessWorkingHours.findAll({
        where: { userId: shopOwnerId },
        attributes: ['id', 'dayOfWeek', 'openTime', 'closeTime', 'status', 'userId'],
    });
    return { bussinesWorkingHours, platformOperationalHours };
}

module.exports = {
    getBusinessInformation,
    getPlatformOperationalHours,
    getWorkingHours,
};
