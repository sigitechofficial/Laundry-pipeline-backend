const { countries, cities, zone, units, addressDb, bussinessInformation, roles, classifiedAs, features, onHoldOption, onHoldCustomerOption, preferenceTypes, preferenceValues, preferencesServiceName, reason } = require('../../models');
const { Op } = require('sequelize');
const geolib = require('geolib');

class DataService {
    /**
     * Get all countries
     * @returns {Array} List of all countries
     */
    async getCountries() {
        try {
            const getCountry = await countries.findAll();
            return getCountry;
        } catch (error) {
            throw new Error(`Countries service error: ${error.message}`);
        }
    }

    /**
     * Get all cities
     * @returns {Array} List of all cities
     */
    async getCities() {
        try {
            const getCities = await cities.findAll();
            return getCities;
        } catch (error) {
            throw new Error(`Cities service error: ${error.message}`);
        }
    }

    /**
     * Get all zones with additional information
     * @returns {Array} List of zones with shop counts and other details
     */
    async getZones() {
        try {
            const zones = await zone.findAll({
                include: [
                    {
                        model: cities,
                        attributes: ['name'],
                    },
                    {
                        model: units,
                        as: 'distanceUnitZ',
                        attributes: ['name', 'symbol'],
                    },
                    {
                        model: units,
                        as: 'currencyUnitZ',
                        attributes: ['name', 'symbol'],
                    },
                    {
                        model: require('../../models').users,
                        as: 'zoneAdmin',
                        attributes: ['firstName', 'lastName'],
                    }
                ]
            });

            const shopCounts = await addressDb.findAll({
                where: { addressType: 'laundaryShopAddress' },
                attributes: ['zoneId'],
                group: ['zoneId'],
                raw: true,
                logging: false,
                attributes: [
                    'zoneId',
                    [require('sequelize').fn('COUNT', '*'), 'shopCount']
                ]
            });

            const shopMap = shopCounts.reduce((acc, curr) => {
                acc[curr.zoneId] = parseInt(curr.shopCount, 10);
                return acc;
            }, {});

            const shapedZones = zones.map(zone => {
                const radius = this.calculateZoneRadius(zone.coordinates); // in km

                return {
                    zoneId: zone.id,
                    zoneName: zone.name,
                    cityName: zone.city?.name || "",
                    zoneMinimumAmount: zone.zoneMinimumAmount,
                    zoneCoordinates: zone.coordinates,
                    serviceCharge: zone.serviceCharge,
                    zoneAdminCommission: `${zone.zoneAdminCommission}%`,
                    currencyUnit: zone.currencyUnitZ ? `${zone.currencyUnitZ.name} (${zone.currencyUnitZ.symbol})` : "",
                    distanceUnit: zone.distanceUnitZ ? `${zone.distanceUnitZ.name} (${zone.distanceUnitZ.symbol})` : "",
                    radius: `${radius} km`,
                    adminName: zone.zoneAdmin
                        ? `${zone.zoneAdmin.firstName || ''} ${zone.zoneAdmin.lastName || ''}`.trim()
                        : '',
                    totalShops: shopMap[zone.id] || 0
                };
            });

            return shapedZones;
        } catch (error) {
            throw new Error(`Zones service error: ${error.message}`);
        }
    }

    /**
     * Get units for distance and currency
     * @returns {Array} List of distance and currency units
     */
    async getUnitsDistanceAndCurrency() {
        try {
            const getUnits = await units.findAll({
                where: {
                    type: {
                        [Op.or]: ['distance', 'currency']
                    }
                },
                attributes: ['id', 'name', 'symbol', 'type', 'status']
            });
            return getUnits;
        } catch (error) {
            throw new Error(`Units service error: ${error.message}`);
        }
    }

    /**
     * Get all units
     * @returns {Array} List of all units
     */
    async getAllUnits() {
        try {
            const getUnits = await units.findAll();
            return getUnits;
        } catch (error) {
            throw new Error(`All units service error: ${error.message}`);
        }
    }

    /**
     * Get all roles
     * @returns {Array} List of all active roles
     */
    async getAllRoles() {
        try {
            const getRoles = await roles.findAll({
                where: {
                    status: true
                },
                attributes: ['id', 'name', 'status']
            });
            return getRoles;
        } catch (error) {
            throw new Error(`All roles service error: ${error.message}`);
        }
    }

    /**
     * Get all classified as options
     * @returns {Array} List of all classified as options
     */
    async getClassifiedAs() {
        try {
            const findData = await classifiedAs.findAll({
                attributes: ['id', 'name']
            });
            return findData;
        } catch (error) {
            throw new Error(`Classified as service error: ${error.message}`);
        }
    }

    /**
     * Get all features
     * @returns {Array} List of all active features
     */
    async getFeatures() {
        try {
            const findFeature = await features.findAll({
                where: {
                    status: true
                },
                attributes: ['id', 'name', 'status']
            });
            return findFeature;
        } catch (error) {
            throw new Error(`Features service error: ${error.message}`);
        }
    }

    /**
     * Get on hold options
     * @returns {Array} List of all active on hold options
     */
    async getOnHoldOptions() {
        try {
            const getOptions = await onHoldOption.findAll({
                where: {
                    status: true
                },
                attributes: ['id', 'option', 'status']
            });
            return getOptions;
        } catch (error) {
            throw new Error(`On hold options service error: ${error.message}`);
        }
    }

    /**
     * Get on hold customer options
     * @returns {Array} List of on hold customer options with related data
     */
    async getOnHoldCustomerOptions() {
        try {
            const optionsFound = await onHoldCustomerOption.findAll({
                include: [{
                    model: onHoldOption,
                    where: {
                        status: true
                    },
                    attributes: ['id', 'option', 'status']
                }],
                attributes: ['id', 'option', 'title', 'conformationText', 'notConfirmText', 'onHoldOptionId']
            });
            return optionsFound;
        } catch (error) {
            throw new Error(`On hold customer options service error: ${error.message}`);
        }
    }

    /**
     * Get preference types with values
     * @returns {Array} List of preference types with their values
     */
    async getPreferenceTypes() {
        try {
            const getPreferenceTypes = await preferenceTypes.findAll({
                where: {
                    status: true
                },
                include: [
                    {
                        model: preferenceValues,
                        as: 'preferenceValues',
                        where: {
                            status: true
                        },
                        required: false,
                        order: [['id', 'DESC']],
                        attributes: ['id', 'value', 'status']
                    }
                ],
                attributes: ['id', 'name', 'status']
            });
            return getPreferenceTypes;
        } catch (error) {
            throw new Error(`Preference types service error: ${error.message}`);
        }
    }

    /**
     * Get account preferences
     * @returns {Array} List of account preferences
     */
    async getAccountPreferences() {
        try {
            const preFind = await preferencesServiceName.findAll({
                attributes: ['title', 'status']
            });
            return preFind;
        } catch (error) {
            throw new Error(`Account preferences service error: ${error.message}`);
        }
    }

    /**
     * Get cancel booking reasons
     * @returns {Array} List of cancel booking reasons
     */
    async getCancelBookingReasons() {
        try {
            const getBooking = await reason.findAll({
                attributes: ['id', 'cancelReason']
            });
            return getBooking;
        } catch (error) {
            throw new Error(`Cancel booking reasons service error: ${error.message}`);
        }
    }

    /**
     * Calculate zone radius from polygon coordinates
     * @param {Object} polygon - Polygon coordinates
     * @returns {number} Radius in kilometers
     */
    calculateZoneRadius(polygon) {
        if (!polygon || !polygon.coordinates || !polygon.coordinates[0]) return 0;

        const points = polygon.coordinates[0].map(([lng, lat]) => ({ latitude: lat, longitude: lng }));

        const center = geolib.getCenter(points);
        const maxDistance = Math.max(...points.map(point => geolib.getDistance(center, point))); // in meters

        return (maxDistance / 1000).toFixed(2); // return km
    }
}

module.exports = new DataService();
