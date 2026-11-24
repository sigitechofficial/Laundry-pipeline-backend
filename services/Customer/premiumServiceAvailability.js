'use strict';

/**
 * Premium services (a badge set in admin, e.g. "Premium · Eco" on Eco Dry Clean)
 * need special kit, so only some shops switch them on. Orders only go to shops
 * that offer every service in the order, so a customer must not be shown a
 * premium service in a zone where no active shop offers it.
 *
 * Services without a badge are never touched here.
 */
const { Op } = require('sequelize');
const { addressDb, agentSelectServices } = require('../../models');

const hasBadge = (svc) => String(svc?.badgeText ?? '').trim().length > 0;

/**
 * Ids of the badge services (from [services]) that at least one active shop in
 * [zoneId] offers. Without a zone nothing can be checked, so all are kept.
 */
async function premiumServiceIdsOfferedInZone(services, zoneId) {
    const premiumIds = (services || []).filter(hasBadge).map((s) => Number(s.id));
    if (!premiumIds.length || !zoneId) return new Set(premiumIds);

    const offers = await agentSelectServices.findAll({
        where: { serviceId: { [Op.in]: premiumIds }, status: true },
        attributes: ['serviceId', 'agentServiceId'],
        raw: true,
    });
    if (!offers.length) return new Set();

    const shops = await addressDb.findAll({
        where: {
            zoneId,
            addressType: 'LaundaryShopAddress',
            status: true,
            userId: { [Op.in]: [...new Set(offers.map((o) => o.agentServiceId))] },
        },
        attributes: ['userId'],
        raw: true,
    });
    const shopUsers = new Set(shops.map((s) => Number(s.userId)));
    return new Set(
        offers
            .filter((o) => shopUsers.has(Number(o.agentServiceId)))
            .map((o) => Number(o.serviceId))
    );
}

/**
 * [services] without the badge services no active shop in [zoneId] offers.
 * [getService] reads the service row from each item (default: the item).
 */
async function hidePremiumServicesWithoutShop(services, zoneId, getService = (s) => s) {
    const rows = (services || []).map(getService);
    if (!rows.some(hasBadge)) return services;
    const offered = await premiumServiceIdsOfferedInZone(rows, zoneId);
    return (services || []).filter((item) => {
        const svc = getService(item);
        return !hasBadge(svc) || offered.has(Number(svc.id));
    });
}

module.exports = { premiumServiceIdsOfferedInZone, hidePremiumServicesWithoutShop };
