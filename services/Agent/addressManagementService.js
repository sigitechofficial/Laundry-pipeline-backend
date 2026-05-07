require("dotenv").config();
const { addressDb, countries, cities, zone, sequelize } = require('../../models');
const { Op } = require('sequelize');
const axios = require('axios');
const { 
    UnauthorizedError, 
    NotFoundError, 
    ConflictError, 
    ValidationError 
} = require('../../middlewares/universalErrorHandler');
const checkServiceAvailability = require('../../utils/haversineFormula');

/**
 * Agent Address Management Service
 * Handles all agent address related business logic
 */
class AgentAddressManagementService {

    /**
     * Add Agent Address
     * @param {Object} data - Address data
     * @param {string} data.streetAddress - Street address
     * @param {string} data.district - District
     * @param {string} data.province - Province
     * @param {number} data.lat - Latitude
     * @param {number} data.lng - Longitude
     * @param {Array} data.coordinates - Coordinates array
     * @param {string} data.addressType - Address type
     * @param {number} data.userId - User ID
     * @param {string} data.postalcode - Postal code
     * @returns {Object} Address creation result
     */
    async agentAddressAdd(data) {
        const {
            streetAddress,
            district,
            province,
            lat,
            lng,
            coordinates,
            addressType,
            userId,
            postalcode
        } = data;

        const findAgentShopAddress = await addressDb.findAll({
            where: {
                userId: userId,
            },
        });

        if (findAgentShopAddress.length > 0) {
            throw new ConflictError("Already Added the Shop Address");
        }

        const polygon = {
            type: "Polygon",
            coordinates: coordinates,
        };

        const fetchZones = await this.findZones(lat, lng);
        console.log("🚀 ~ agentAddressAdd ~ fetchZones:", fetchZones[0].id);
        console.log("🚀 ~ agentAddressAdd ~ fetchZones:", fetchZones[0].city.id);
        console.log(
            "🚀 ~ agentAddressAdd ~ fetchZones:",
            fetchZones[0].city.country.id
        );

        // return res.json(fetchZones);

        const registerShop = await addressDb.create({
            streetAddress,
            district,
            cityId: fetchZones[0].city.id,
            province,
            countryId: fetchZones[0].city.country.id,
            lat,
            lng,
            status: true,
            postalcode,
            coordinates: polygon,
            userId: userId,
            zoneId: fetchZones[0].id,
            addressType,
        });

        return {
            registerShop,
        };
    }

    /**
     * Edit Agent Address
     * @param {Object} data - Address data
     * @param {string} data.streetAddress - Street address
     * @param {string} data.district - District
     * @param {string} data.province - Province
     * @param {number} data.lat - Latitude
     * @param {number} data.lng - Longitude
     * @param {Array} data.coordinates - Coordinates array
     * @param {string} data.addressType - Address type
     * @param {number} data.addressId - Address ID
     * @param {string} data.postalcode - Postal code
     * @param {number} agentId - Agent ID
     * @returns {Object} Address update result
     */
    async agentAddressEdit(data, agentId) {
        const {
            streetAddress,
            district,
            province,
            lat,
            lng,
            coordinates,
            addressType,
            addressId,
            postalcode
        } = data;

        console.log("req.body===================>>>", data);

        // Check if address exists for this user
        const existingAddress = await addressDb.findOne({
            where: {
                addressType: "LaundaryShopAddress",
                userId: agentId,
            },
        });

        console.log("existingAddress===================>>>", existingAddress.id);

        if (!existingAddress) {
            throw new NotFoundError("No shop address found to edit. Please add an address first.");
        }

        const polygon = {
            type: "Polygon",
            coordinates: coordinates,
        };

        const fetchZones = await this.findZones(lat, lng);
        console.log("🚀 ~ agentAddressEdit ~ fetchZones:", fetchZones[0].id);
        console.log("🚀 ~ agentAddressEdit ~ fetchZones:", fetchZones[0].city.id);
        console.log(
            "🚀 ~ agentAddressEdit ~ fetchZones:",
            fetchZones[0].city.country.id
        );

        const updatedAddress = await addressDb.update({
            streetAddress,
            district,
            cityId: fetchZones[0].city.id,
            province,
            countryId: fetchZones[0].city.country.id,
            lat,
            lng,
            postalcode,
            coordinates: polygon,
            zoneId: fetchZones[0].id,
        }, {
            where: {
                id: existingAddress.id
            }
        });

        return {
            updatedAddress,
        };
    }

    /**
     * Get Agent Address
     * @param {number} agentId - Agent ID
     * @returns {Object} Agent address data
     */
    async getAgentAddress(agentId) {
        const agentAddress = await addressDb.findOne({
            where: {
                userId: agentId,
                addressType: "LaundaryShopAddress",
            },
            attributes: [
                "id",
                "streetAddress",
                "district",
                "province",
                "postalCode",
                "lat",
                "lng",
                "coordinates",
                "addressType",
                "zoneId",
                "cityId",
                "countryId",
                "status"
            ],
            include: [
                {
                    model: countries,
                    attributes: ["id", "name", "shortName"],
                },
                {
                    model: cities,
                    attributes: ["id", "name"],
                },
                {
                    model: zone,
                    attributes: ["id", "name", "zoneMinimumAmount", "serviceCharge"],
                }
            ]
        });

        if (!agentAddress) {
            throw new NotFoundError("No address found for this agent");
        }

        return {
            agentAddress,
        };
    }

    /**
     * Get Shop Address
     * @param {number} userId - User ID
     * @returns {Object} Shop address data
     */
    async getShopAddress(userId) {
        const shopAddress = await addressDb.findOne({
            where: {
                userId: userId,
                addressType: "LaundaryShopAddress",
            },
            attributes: [
                "id",
                "streetAddress",
                "district",
                "province",
                "postalCode",
                "lat",
                "lng",
                "coordinates",
                "addressType",
                "zoneId",
                "cityId",
                "countryId",
                "status"
            ],
            include: [
                {
                    model: countries,
                    attributes: ["id", "name", "shortName"],
                },
                {
                    model: cities,
                    attributes: ["id", "name"],
                },
                {
                    model: zone,
                    attributes: ["id", "name", "zoneMinimumAmount", "serviceCharge"],
                }
            ]
        });

        if (!shopAddress) {
            throw new NotFoundError("No shop address found");
        }

        return {
            shopAddress,
        };
    }

    /**
     * Extract UK outcode from a full postcode.
     * e.g. "SW1A 1AA" → "SW1A", "NW1 1AA" → "NW1"
     */
    extractOutcode(postcode) {
        const normalized = postcode.trim().replace(/\s+/g, '').toUpperCase();
        return normalized.slice(0, normalized.length - 3);
    }

    /**
     * Shared include config for zone queries in this service
     */
    get zoneInclude() {
        return [
            {
                model: cities,
                attributes: ["id", "name", "lat", "lng", "status"],
                include: [
                    {
                        model: countries,
                        attributes: ["id", "name", "shortName", "status"],
                    },
                ],
            },
        ];
    }

    /**
     * Find zone by postcode using JSON_CONTAINS.
     * Handles both outcode (SW1A) and full postcode (SW1A 1AA) matching.
     */
    async findZoneByPostcode(postcode) {
        const normalized = postcode.trim().replace(/\s+/g, '').toUpperCase();
        const outcode = this.extractOutcode(normalized);

        console.log(`🔍 [Agent] Postcode lookup — full: "${normalized}", outcode: "${outcode}"`);

        const zones = await zone.findAll({
            where: {
                status: true,
                [Op.or]: [
                    sequelize.where(
                        sequelize.fn('JSON_CONTAINS', sequelize.col('postcodes'), JSON.stringify(normalized)),
                        true
                    ),
                    sequelize.where(
                        sequelize.fn('JSON_CONTAINS', sequelize.col('postcodes'), JSON.stringify(outcode)),
                        true
                    ),
                ]
            },
            include: this.zoneInclude,
            attributes: ["id", "zoneMinimumAmount", "serviceCharge", "status", "postcodes"],
        });

        console.log(`📮 [Agent] Postcode zone lookup found ${zones.length} zone(s)`);
        return zones;
    }

    /**
     * Find zones based on coordinates
     * Step 1: Reverse-geocode lat/lng → postcode via postcodes.io
     * Step 2: Match zone by postcode (outcode or full)
     * Step 3: Fallback to geometry ST_Contains if postcode lookup fails
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @returns {Array} Zone data
     */
    async findZones(lat, lng) {
        console.log(`[Agent] Finding zone for coordinates: { lat: ${lat}, lng: ${lng} }`);

        // ── Step 1: Reverse-geocode lat/lng → postcode ────────────────────────
        let postcodeLookupResult = null;
        try {
            const response = await axios.get(
                `https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}`,
                { timeout: 5000 }
            );
            if (response.data.status === 200 && response.data.result && response.data.result.length > 0) {
                postcodeLookupResult = response.data.result[0].postcode;
                console.log(`📮 [Agent] Reverse geocode result: "${postcodeLookupResult}"`);
            }
        } catch (err) {
            console.warn("⚠️ [Agent] postcodes.io reverse geocode failed, falling back to geometry:", err.message);
        }

        // ── Step 2: Try postcode-based zone lookup ────────────────────────────
        if (postcodeLookupResult) {
            const postcodeZones = await this.findZoneByPostcode(postcodeLookupResult);
            if (postcodeZones.length > 0) {
                console.log("✅ [Agent] Zone found via postcode lookup:", postcodeZones[0].id);
                return postcodeZones;
            }
            console.log("⚠️ [Agent] No zone matched by postcode, falling back to geometry...");
        }

        // ── Step 3: Fallback — geometry-based lookup (ST_Contains) ───────────
        console.log("🗺️ [Agent] Trying geometry-based zone lookup...");
        const findZone = await zone.findAll({
            where: {
                status: true,
                coordinates: sequelize.where(
                    sequelize.fn(
                        "ST_Contains",
                        sequelize.col("coordinates"),
                        sequelize.fn("ST_GeomFromText", `POINT(${lng} ${lat})`)
                    ),
                    true
                ),
            },
            include: this.zoneInclude,
            attributes: ["id", "zoneMinimumAmount", "serviceCharge", "status", "postcodes"],
        });

        if (!findZone || findZone.length === 0) {
            throw new NotFoundError("No zone found for these coordinates");
        }

        console.log(`✅ [Agent] Zone found via geometry: ${findZone[0].id}`);
        return findZone;
    }
}

module.exports = new AgentAddressManagementService();
