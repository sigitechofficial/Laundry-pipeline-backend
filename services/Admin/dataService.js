const { countries, cities, zone, units, addressDb, bussinessInformation, roles, classifiedAs, features, onHoldOption, onHoldCustomerOption, preferenceTypes, preferenceValues, preferencesServiceName, reason } = require('../../models');
const { Op } = require('sequelize');
const geolib = require('geolib');
const { literal, fn, col } = require("sequelize");

class DataService {
    /**
     * Get all countries
     * @returns {Array} List of all countries
     */
    async getCountries() {
        const getCountry = await countries.findAll();
        return getCountry;
    }

    /**
     * Get all cities
     * @returns {Array} List of all cities
     */
    async getCities() {
        const getCities = await cities.findAll();
        return getCities;
    }

        /**
     * Get all cities on the basis of country id
     * @param {number} countryId - Optional country ID to filter cities
     * @returns {Array} List of all cities
     */
    async getCitiesByCountryId(countryId) {
        const getCities = await cities.findAll({
            where: {
                countryId
            },
            include: [
                {
                    model: countries,
                    attributes: ['id','name', 'shortName']
                }
            ],
            order: [['createdAt', 'DESC']]
        });
        return getCities;
    }

    /**
     * Get all zones with additional information
     * @returns {Array} List of zones with shop counts and other details
     */
    async getZones() {
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
    }

    /**
     * Get units based on type
     * @param {string|Array} type - Optional type(s) to filter units (e.g., 'distance', 'currency', 'length', 'weight')
     *                              Can be a single type or comma-separated string or array
     * @returns {Array} List of units filtered by type(s)
     * @example
     */
    async getUnitsDistanceAndCurrency(type = null) {
        const whereClause = {};
        
        if (type) {
            // If type is a string with comma-separated values, split it
            const types = typeof type === 'string' ? type.split(',').map(t => t.trim()) : [type];
            whereClause.type = { [Op.or]: types };
        }
        // If no type provided, return all types
        
        const getUnits = await units.findAll({
            where: whereClause,
            attributes: ['id', 'name', 'symbol', 'type', 'status', 'conversionRate'],
            order: [['type', 'ASC'], ['name', 'ASC']]
        });
        return getUnits;
    }

    /**
     * Get all units
     * @returns {Array} List of all units
     */
    async getAllUnits() {
        const getUnits = await units.findAll();
        return getUnits;
    }

    /**
     * Get all roles
     * @returns {Array} List of all active roles
     */
    async getAllRoles() {
        const getRoles = await roles.findAll({
            where: {
                status: true
            },
            attributes: ['id', 'name', 'status']
        });
        return getRoles;
    }

    /**
     * Get all classified as options
     * @returns {Array} List of all classified as options
     */
    async getClassifiedAs() {
        const findData = await classifiedAs.findAll({
            attributes: ['id', 'name']
        });
        return findData;
    }

    /**
     * Get all features
     * @returns {Array} List of all active features
     */
    async getFeatures() {
        const findFeature = await features.findAll({
            where: {
                status: true
            },
            attributes: ['id', 'name', 'status']
        });
        return findFeature;
    }

    /**
     * Get on hold options
     * @returns {Array} List of all active on hold options
     */
    async getOnHoldOptions() {
        const getOptions = await onHoldOption.findAll({
            where: {
                status: true
            },
            attributes: ['id', 'option', 'status']
        });
        return getOptions;
    }

    /**
     * Get on hold customer options
     * @returns {Array} List of on hold customer options with related data
     */
    async getOnHoldCustomerOptions() {
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
    }

    /**
     * Get preference types with values
     * @returns {Array} List of preference types with their values
     */
    async getPreferenceTypes() {
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
            attributes: ['id', 'name', 'status', 'parentPreferenceTypeId']
        });
        return getPreferenceTypes;
    }

    /**
     * Get account preferences
     * @returns {Array} List of account preferences
     */
    async getAccountPreferences() {
        const preFind = await preferencesServiceName.findAll({
            attributes: ['title', 'status']
        });
        return preFind;
    }

    /**
     * Get cancel booking reasons
     * @returns {Array} List of cancel booking reasons
     */
    async getCancelBookingReasons() {
        const getBooking = await reason.findAll({
            attributes: ['id', 'cancelReason']
        });
        return getBooking;
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
