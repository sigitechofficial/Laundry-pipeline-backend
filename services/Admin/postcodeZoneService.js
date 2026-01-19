require("dotenv").config();
const axios = require('axios');
const turf = require('@turf/turf');
const { zone, cities, units, users } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

class PostcodeZoneService {
    /**
     * Fetch coordinates for postcodes using postcodes.io API
     * @param {Array<string>} postcodes - Array of postcode strings
     * @returns {Array<{postcode: string, longitude: number, latitude: number}>}
     */
    async fetchPostcodeCoordinates(postcodes) {
        const coordinates = [];
        
        for (const postcode of postcodes) {
            try {
                // Normalize postcode (remove spaces, uppercase)
                const normalizedPostcode = postcode.trim().replace(/\s+/g, '').toUpperCase();
                
                const response = await axios.get(
                    `https://api.postcodes.io/postcodes/${encodeURIComponent(normalizedPostcode)}`,
                    { timeout: 5000 }
                );

                if (response.data.status === 200 && response.data.result) {
                    coordinates.push({
                        postcode: normalizedPostcode,
                        longitude: response.data.result.longitude,
                        latitude: response.data.result.latitude
                    });
                } else {
                    throw new ValidationError(`Invalid postcode: ${postcode}`);
                }
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    throw new ValidationError(`Postcode not found: ${postcode}`);
                }
                throw new ValidationError(`Failed to fetch coordinates for postcode: ${postcode}. ${error.message}`);
            }
        }

        if (coordinates.length === 0) {
            throw new ValidationError('No valid postcodes found');
        }

        return coordinates;
    }

    /**
     * Create polygon coordinates from postcode coordinates
     * @param {Array<{longitude: number, latitude: number}>} postcodeCoordinates
     * @returns {Array} Polygon coordinates array in format [[[lng, lat], [lng, lat], ...]]
     */
    createPolygonFromPostcodes(postcodeCoordinates) {
        if (postcodeCoordinates.length === 1) {
            // Single postcode: create a small buffer around the point (approximately 1km radius)
            const point = postcodeCoordinates[0];
            const bufferRadius = 1; // 1 kilometer
            const buffered = turf.buffer(
                turf.point([point.longitude, point.latitude]),
                bufferRadius,
                { units: 'kilometers' }
            );
            
            // Extract coordinates from the buffered polygon
            return buffered.geometry.coordinates;
        } else {
            // Multiple postcodes: create convex hull to connect all points
            const points = postcodeCoordinates.map(pc => 
                turf.point([pc.longitude, pc.latitude])
            );
            
            const featureCollection = turf.featureCollection(points);
            const hull = turf.convex(featureCollection);
            
            if (!hull || !hull.geometry || !hull.geometry.coordinates) {
                throw new ValidationError('Failed to create zone polygon from postcodes');
            }
            
            return hull.geometry.coordinates;
        }
    }

    /**
     * Validate zone data before creation
     * @param {Object} data - Zone data
     */
    async validateZoneData(data) {
        // Validate city exists
        if (data.cityId) {
            const cityExists = await cities.findByPk(data.cityId);
            if (!cityExists) {
                throw new NotFoundError('City not found');
            }
        }

        // Validate currencyUnitId if provided
        if (data.currencyUnitId) {
            const currencyUnit = await units.findByPk(data.currencyUnitId);
            if (!currencyUnit) {
                throw new NotFoundError('Currency unit not found');
            }
        }

        // Validate distanceUnitId if provided
        if (data.distanceUnitId) {
            const distanceUnit = await units.findByPk(data.distanceUnitId);
            if (!distanceUnit) {
                throw new NotFoundError('Distance unit not found');
            }
        }

        // Validate zoneAdminId if provided
        if (data.zoneAdminId) {
            const adminUser = await users.findByPk(data.zoneAdminId);
            if (!adminUser) {
                throw new NotFoundError('Zone admin user not found');
            }
        }
    }

    /**
     * Add zone using postcodes
     * @param {Object} zoneData - Zone data containing postcodes array and other zone fields
     * @returns {Object} Created zone data
     */
    async addZoneByPostcodes(zoneData) {
        const { postcodes, ...otherZoneData } = zoneData;

        // Validate required fields
        if (!postcodes || !Array.isArray(postcodes) || postcodes.length === 0) {
            throw new ValidationError('At least one postcode is required');
        }

        if (!zoneData.name) {
            throw new ValidationError('Zone name is required');
        }

        if (!zoneData.cityId) {
            throw new ValidationError('City ID is required');
        }

        // Fetch coordinates for all postcodes
        const postcodeCoordinates = await this.fetchPostcodeCoordinates(postcodes);

        // Create polygon from postcode coordinates
        const polygonCoordinates = await this.createPolygonFromPostcodes(postcodeCoordinates);

        // Prepare final zone data
        const data = {
            ...otherZoneData,
            coordinates: {
                type: 'Polygon',
                coordinates: polygonCoordinates
            },
            zoneAdminComission: zoneData.zoneAdminComission || 20,
            status: zoneData.status !== undefined ? zoneData.status : true
        };

        // Validate zone data (city, units, admin)
        await this.validateZoneData(data);

        // Create zone
        const zoneCreate = await zone.create(data);
        return zoneCreate;
    }
}

module.exports = new PostcodeZoneService();

