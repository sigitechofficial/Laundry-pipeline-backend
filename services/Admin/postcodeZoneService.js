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
        // Validate input
        if (!postcodeCoordinates || !Array.isArray(postcodeCoordinates)) {
            console.error('Invalid postcodeCoordinates:', postcodeCoordinates);
            throw new ValidationError('Invalid postcode coordinates: must be an array');
        }

        if (postcodeCoordinates.length === 0) {
            throw new ValidationError('No postcode coordinates provided');
        }

        console.log(`Creating polygon from ${postcodeCoordinates.length} postcodes`);
        
        if (postcodeCoordinates.length === 1) {
            // Single postcode: create a small buffer around the point (approximately 1km radius)
            const point = postcodeCoordinates[0];
            
            // Validate point data
            if (!point || typeof point.longitude !== 'number' || typeof point.latitude !== 'number') {
                console.error('Invalid point data:', point);
                throw new ValidationError('Invalid coordinate data for postcode');
            }

            const bufferRadius = 1; // 1 kilometer
            const buffered = turf.buffer(
                turf.point([point.longitude, point.latitude]),
                bufferRadius,
                { units: 'kilometers' }
            );
            
            // Extract coordinates from the buffered polygon
            const coords = buffered.geometry.coordinates;
            console.log('✅ Single postcode polygon created:', JSON.stringify(coords[0]));
            return this.validateAndClosePolygon(coords);
        } else if (postcodeCoordinates.length === 2) {
            // Two postcodes: create a buffer around the line connecting them
            const point1 = postcodeCoordinates[0];
            const point2 = postcodeCoordinates[1];
            
            // Validate points
            if (!point1 || !point2 || 
                typeof point1.longitude !== 'number' || typeof point1.latitude !== 'number' ||
                typeof point2.longitude !== 'number' || typeof point2.latitude !== 'number') {
                console.error('Invalid point data:', { point1, point2 });
                throw new ValidationError('Invalid coordinate data for postcodes');
            }

            const line = turf.lineString([
                [point1.longitude, point1.latitude],
                [point2.longitude, point2.latitude]
            ]);
            const buffered = turf.buffer(line, 0.5, { units: 'kilometers' });
            
            const coords = buffered.geometry.coordinates;
            console.log('✅ Two postcode polygon created:', JSON.stringify(coords[0]));
            return this.validateAndClosePolygon(coords);
        } else {
            // Multiple postcodes (3+): create convex hull to connect all points
            console.log('Creating convex hull for multiple postcodes');
            
            // Validate all points before creating
            const invalidPoints = postcodeCoordinates.filter(pc => 
                !pc || typeof pc.longitude !== 'number' || typeof pc.latitude !== 'number'
            );
            
            if (invalidPoints.length > 0) {
                console.error('Found invalid points:', invalidPoints);
                throw new ValidationError(`Found ${invalidPoints.length} invalid coordinate(s)`);
            }

            const points = postcodeCoordinates.map((pc, index) => {
                const point = turf.point([pc.longitude, pc.latitude]);
                console.log(`Point ${index}:`, [pc.longitude, pc.latitude]);
                return point;
            });
            
            const featureCollection = turf.featureCollection(points);
            console.log('Feature collection created with', points.length, 'points');
            
            const hull = turf.convex(featureCollection);
            
            console.log('Convex hull result:', hull ? 'Success' : 'Failed');
            
            if (!hull || !hull.geometry || !hull.geometry.coordinates) {
                console.error('Convex hull creation failed. Hull:', hull);
                console.error('Points provided:', points.length);
                
                // Fallback: Create a buffer around all points combined
                console.log('Using fallback: creating buffer around points');
                const multiPoint = turf.multiPoint(postcodeCoordinates.map(pc => [pc.longitude, pc.latitude]));
                const buffered = turf.buffer(multiPoint, 1, { units: 'kilometers' });
                
                if (!buffered || !buffered.geometry || !buffered.geometry.coordinates) {
                    throw new ValidationError('Failed to create zone polygon from postcodes');
                }
                
                const coords = buffered.geometry.coordinates;
                console.log('✅ Fallback polygon created:', JSON.stringify(coords[0]));
                return this.validateAndClosePolygon(coords);
            }
            
            const coords = hull.geometry.coordinates;
            console.log('✅ Convex hull polygon created:', JSON.stringify(coords[0]));
            return this.validateAndClosePolygon(coords);
        }
    }

    /**
     * Ensure polygon is properly closed and formatted for Sequelize GEOMETRY
     * @param {Array} coordinates - Polygon coordinates from turf
     * @returns {Array} Validated and closed polygon coordinates
     */
    validateAndClosePolygon(coordinates) {
        console.log('🔍 Validating polygon structure...');
        console.log('Input coordinates structure:', JSON.stringify(coordinates));
        
        // Ensure coordinates is in the right format [[[lng, lat], [lng, lat], ...]]
        if (!Array.isArray(coordinates) || coordinates.length === 0) {
            throw new ValidationError('Invalid polygon coordinates structure');
        }

        // Get the outer ring (first element)
        let outerRing = coordinates[0];
        
        if (!Array.isArray(outerRing) || outerRing.length < 3) {
            throw new ValidationError('Polygon must have at least 3 points');
        }

        console.log(`Polygon has ${outerRing.length} points before closing check`);
        
        // Check if polygon is closed (first point === last point)
        const firstPoint = outerRing[0];
        const lastPoint = outerRing[outerRing.length - 1];
        
        const isClosed = firstPoint[0] === lastPoint[0] && firstPoint[1] === lastPoint[1];
        
        if (!isClosed) {
            console.log('⚠️ Polygon not closed, closing it now');
            console.log('First point:', firstPoint);
            console.log('Last point:', lastPoint);
            // Close the polygon by adding the first point at the end
            outerRing.push([...firstPoint]);
            console.log('✅ Polygon closed. New last point:', outerRing[outerRing.length - 1]);
        } else {
            console.log('✅ Polygon already closed');
        }
        
        console.log(`Final polygon has ${outerRing.length} points`);
        console.log('First 3 points:', JSON.stringify(outerRing.slice(0, 3)));
        console.log('Last 3 points:', JSON.stringify(outerRing.slice(-3)));
        
        return [outerRing];
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
        console.log('=== Add Zone By Postcodes - Start ===');
        console.log('Received zoneData:', JSON.stringify(zoneData, null, 2));
        
        const { postcodes, ...otherZoneData } = zoneData;

        // Validate required fields
        console.log('Postcodes received:', postcodes);
        console.log('Postcodes type:', typeof postcodes);
        console.log('Is array:', Array.isArray(postcodes));
        
        if (!postcodes) {
            throw new ValidationError('Postcodes field is required');
        }

        // Handle case where postcodes might be sent as string from frontend
        let postcodesArray = postcodes;
        if (typeof postcodes === 'string') {
            console.log('Postcodes is a string, attempting to parse...');
            try {
                postcodesArray = JSON.parse(postcodes);
            } catch (e) {
                // If not JSON, try splitting by comma
                postcodesArray = postcodes.split(',').map(p => p.trim()).filter(p => p);
            }
            console.log('Parsed postcodes:', postcodesArray);
        }

        if (!Array.isArray(postcodesArray) || postcodesArray.length === 0) {
            throw new ValidationError('At least one postcode is required (must be an array)');
        }

        if (!zoneData.name) {
            throw new ValidationError('Zone name is required');
        }

        if (!zoneData.cityId) {
            throw new ValidationError('City ID is required');
        }

        console.log(`Processing ${postcodesArray.length} postcodes...`);

        // Fetch coordinates for all postcodes
        const postcodeCoordinates = await this.fetchPostcodeCoordinates(postcodesArray);
        console.log('Fetched coordinates:', postcodeCoordinates.length);

        // Create polygon from postcode coordinates
        const polygonCoordinates = await this.createPolygonFromPostcodes(postcodeCoordinates);
        console.log('Polygon created successfully');
        console.log('📍 Polygon coordinates structure:', JSON.stringify(polygonCoordinates, null, 2));

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

        console.log('📦 Final zone data to be saved:', {
            name: data.name,
            cityId: data.cityId,
            coordinatesType: data.coordinates.type,
            coordinatesLength: data.coordinates.coordinates.length,
            firstRingLength: data.coordinates.coordinates[0]?.length,
            firstPoint: data.coordinates.coordinates[0]?.[0],
            lastPoint: data.coordinates.coordinates[0]?.[data.coordinates.coordinates[0].length - 1]
        });

        // Validate zone data (city, units, admin)
        await this.validateZoneData(data);

        // Create zone
        const zoneCreate = await zone.create(data);
        console.log('=== Add Zone By Postcodes - Success ===');
        console.log('✅ Zone created with ID:', zoneCreate.id);
        return zoneCreate;
    }

    /**
     * Edit/update zone by id; optionally regenerate polygon from new postcodes
     * @param {number} zoneId - Zone ID to update
     * @param {Object} zoneData - Zone data (optional postcodes array + any zone fields to update)
     * @returns {Object} Updated zone data
     */
    async editZoneByPostcodes(zoneId, zoneData) {
        const existingZone = await zone.findByPk(zoneId);
        if (!existingZone) {
            throw new NotFoundError('Zone not found');
        }

        const { postcodes, ...otherZoneData } = zoneData;

        // If postcodes provided, regenerate polygon from them
        if (postcodes !== undefined && postcodes !== null) {
            let postcodesArray = postcodes;
            if (typeof postcodes === 'string') {
                try {
                    postcodesArray = JSON.parse(postcodes);
                } catch (e) {
                    postcodesArray = postcodes.split(',').map(p => p.trim()).filter(p => p);
                }
            }
            if (Array.isArray(postcodesArray) && postcodesArray.length > 0) {
                console.log('🔄 Regenerating polygon from postcodes for zone:', zoneId);
                const postcodeCoordinates = await this.fetchPostcodeCoordinates(postcodesArray);
                const polygonCoordinates = await this.createPolygonFromPostcodes(postcodeCoordinates);
                console.log('📍 New polygon coordinates structure:', JSON.stringify(polygonCoordinates, null, 2));
                otherZoneData.coordinates = {
                    type: 'Polygon',
                    coordinates: polygonCoordinates
                };
            }
        }

        const updatePayload = { ...otherZoneData };
        await this.validateZoneData(updatePayload);

        const [affectedRows] = await zone.update(updatePayload, { where: { id: zoneId } });
        if (affectedRows === 0) {
            throw new Error('Failed to update zone');
        }
        const updatedZone = await zone.findByPk(zoneId);
        return updatedZone;
    }
}

module.exports = new PostcodeZoneService();

