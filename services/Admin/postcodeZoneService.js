require("dotenv").config();
const axios = require('axios');
const turf = require('@turf/turf');
const { Op } = require('sequelize');
const { zone, cities, units, users } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

class PostcodeZoneService {
    constructor() {
        // Outcode letter areas used for Greater London postcodes.
        this.londonPostcodeAreas = new Set([
            'E', 'EC', 'N', 'NW', 'SE', 'SW', 'W', 'WC',
            'BR', 'CR', 'DA', 'EN', 'HA', 'IG', 'KT', 'RM', 'SM', 'TW', 'UB', 'WD'
        ]);
    }

    /**
     * Fetch coordinates for postcodes using postcodes.io API
     * @param {Array<string>} postcodes - Array of postcode strings
     * @returns {Array<{postcode: string, longitude: number, latitude: number}>}
     */
    /**
     * Detect whether a normalised postcode string is an outcode (district only, e.g. SW1A, EC1, W1)
     * or a full postcode (e.g. SW1A 2AA).
     * UK outcode pattern: 1-2 letters + 1-2 digits/letters, no incode suffix.
     */
    isOutcode(normalizedPostcode) {
        // Full postcode: ends with a digit followed by two letters (the incode part)
        return !/[0-9][A-Z]{2}$/.test(normalizedPostcode);
    }

    async fetchPostcodeCoordinates(postcodes) {
        const coordinates = [];
        
        for (const postcode of postcodes) {
            // Normalize postcode (remove spaces, uppercase)
            const normalizedPostcode = postcode.trim().replace(/\s+/g, '').toUpperCase();

            if (this.isOutcode(normalizedPostcode)) {
                // ── Outcode path (e.g. SW1A, WC1A, EC1, W1) ─────────────────────
                console.log(`📮 Detected outcode: ${normalizedPostcode} — using /outcodes/ endpoint`);
                try {
                    const response = await axios.get(
                        `https://api.postcodes.io/outcodes/${encodeURIComponent(normalizedPostcode)}`,
                        { timeout: 5000 }
                    );
                    if (response.data.status === 200 && response.data.result) {
                        coordinates.push({
                            postcode: normalizedPostcode,
                            longitude: response.data.result.longitude,
                            latitude: response.data.result.latitude
                        });
                    } else {
                        throw new ValidationError(`Invalid outcode: ${postcode}`);
                    }
                } catch (error) {
                    if (error.response && error.response.status === 404) {
                        throw new ValidationError(`Outcode not found: ${postcode}. Please check the district code (e.g. SW1A, EC1, W1).`);
                    }
                    if (error.isOperational) throw error;
                    throw new ValidationError(`Failed to fetch coordinates for outcode: ${postcode}. ${error.message}`);
                }
            } else {
                // ── Full postcode path (e.g. SW1A 2AA, EC1A 1BB) ─────────────────
                console.log(`📮 Detected full postcode: ${normalizedPostcode} — using /postcodes/ endpoint`);
                try {
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
                        throw new ValidationError(`Postcode not found: ${postcode}. Please use a valid full postcode (e.g. SW1A 2AA) or just the district code (e.g. SW1A).`);
                    }
                    if (error.isOperational) throw error;
                    throw new ValidationError(`Failed to fetch coordinates for postcode: ${postcode}. ${error.message}`);
                }
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
     * Normalize a postcode string for consistent comparison.
     */
    normalizePostcode(postcode) {
        return postcode.trim().replace(/\s+/g, '').toUpperCase();
    }

    extractOutcode(normalizedPostcode) {
        const match = normalizedPostcode.match(/^([A-Z]{1,2}[0-9][0-9A-Z]?)/);
        return match ? match[1] : null;
    }

    isLondonCity(cityName) {
        if (!cityName || typeof cityName !== 'string') return false;
        return cityName.trim().toLowerCase().includes('london');
    }

    isLondonPostcode(normalizedPostcode) {
        const outcode = this.extractOutcode(normalizedPostcode);
        if (!outcode) return false;

        const areaMatch = outcode.match(/^[A-Z]+/);
        if (!areaMatch) return false;

        return this.londonPostcodeAreas.has(areaMatch[0]);
    }

    async validatePostcodesByCity(postcodes, cityId) {
        if (!cityId) return;

        const city = await cities.findByPk(cityId, { attributes: ['id', 'name'] });
        if (!city) {
            throw new NotFoundError('City not found');
        }

        if (!this.isLondonCity(city.name)) {
            return;
        }

        const invalidPostcodes = postcodes
            .map(pc => this.normalizePostcode(pc))
            .filter(pc => !this.isLondonPostcode(pc));

        if (invalidPostcodes.length > 0) {
            throw new ValidationError(
                `Only London postcodes are allowed for city "${city.name}". Invalid postcodes: ${invalidPostcodes.join(', ')}`
            );
        }
    }

    /**
     * Check if two postcodes conflict hierarchically.
     * Conflicts:  exact match, outcode covers full postcode, or full postcode falls inside outcode.
     * e.g. "SW1A" conflicts with "SW1A2AA" and vice-versa, but "SW1A1AA" does NOT conflict with "SW1A2BB".
     */
    postcodesConflict(newPc, existingPc) {
        if (newPc === existingPc) return true;

        const newIsOutcode = this.isOutcode(newPc);
        const existingIsOutcode = this.isOutcode(existingPc);

        if (newIsOutcode && !existingIsOutcode) {
            // New is outcode (SW1A), existing is full (SW1A2AA) → conflict if full starts with outcode
            return existingPc.startsWith(newPc);
        }

        if (!newIsOutcode && existingIsOutcode) {
            // New is full (SW1A2AA), existing is outcode (SW1A) → conflict if full starts with outcode
            return newPc.startsWith(existingPc);
        }

        return false;
    }

    /**
     * Check if any of the given postcodes already belong to an existing zone.
     * Uses hierarchical matching: an outcode (SW1A) conflicts with any full postcode
     * inside it (SW1A 2AA) and vice-versa.
     * @param {Array<string>} postcodes - Postcode strings to check
     * @param {number|null} excludeZoneId - Zone ID to exclude (used during edit so a zone doesn't conflict with itself)
     * @throws {ValidationError} if conflicting postcodes are found
     */
    async checkDuplicatePostcodes(postcodes, excludeZoneId = null) {
        const normalizedInput = postcodes.map(pc => this.normalizePostcode(pc));
        console.log('🔍 [DuplicateCheck] Normalized input postcodes:', normalizedInput);

        // Reject duplicates inside the same request payload.
        const seenInputPostcodes = new Set();
        for (const postcode of normalizedInput) {
            if (seenInputPostcodes.has(postcode)) {
                throw new ValidationError(`Postcode ${postcode} is duplicated in the request`);
            }
            seenInputPostcodes.add(postcode);
        }

        const where = { status: true };
        if (excludeZoneId) {
            where.id = { [Op.ne]: excludeZoneId };
        }

        const existingZones = await zone.findAll({
            where,
            attributes: ['id', 'name', 'postcodes']
        });

        console.log('🔍 [DuplicateCheck] Found', existingZones.length, 'existing active zones');

        for (const existingZone of existingZones) {
            console.log('🔍 [DuplicateCheck] Zone:', existingZone.id, existingZone.name,
                '| postcodes raw:', existingZone.postcodes,
                '| type:', typeof existingZone.postcodes,
                '| isArray:', Array.isArray(existingZone.postcodes));

            let zonePostcodes = existingZone.postcodes;
            if (typeof zonePostcodes === 'string') {
                try { zonePostcodes = JSON.parse(zonePostcodes); } catch (e) { /* ignore */ }
            }
            if (!zonePostcodes || !Array.isArray(zonePostcodes)) continue;

            const existingNormalized = zonePostcodes.map(pc => this.normalizePostcode(pc));
            console.log('🔍 [DuplicateCheck] Existing normalized postcodes:', existingNormalized);

            for (const newPc of normalizedInput) {
                for (const existPc of existingNormalized) {
                    if (this.postcodesConflict(newPc, existPc)) {
                        const newIsOutcode = this.isOutcode(newPc);
                        const existIsOutcode = this.isOutcode(existPc);

                        let message;
                        if (newPc === existPc) {
                            message = `Postcode ${newPc} already exists in zone "${existingZone.name}"`;
                        } else if (newIsOutcode) {
                            message = `Postcode ${newPc} covers area that includes ${existPc}, which already belongs to zone "${existingZone.name}"`;
                        } else {
                            message = `Postcode ${newPc} falls within area ${existPc}, which already belongs to zone "${existingZone.name}"`;
                        }

                        throw new ValidationError(message);
                    }
                }
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

        // Enforce city-specific postcode scope (London-only when city is London)
        await this.validatePostcodesByCity(postcodesArray, zoneData.cityId);

        // Check for duplicate postcodes across existing zones
        await this.checkDuplicatePostcodes(postcodesArray);

        // Fetch coordinates for all postcodes
        const postcodeCoordinates = await this.fetchPostcodeCoordinates(postcodesArray);
        console.log('Fetched coordinates:', postcodeCoordinates.length);

        // Create polygon from postcode coordinates
        const polygonCoordinates = await this.createPolygonFromPostcodes(postcodeCoordinates);
        console.log('Polygon created successfully');
        console.log('📍 Polygon coordinates structure:', JSON.stringify(polygonCoordinates, null, 2));

        // Normalize postcodes for storage
        const normalizedPostcodes = postcodesArray.map(pc => this.normalizePostcode(pc));

        // Prepare final zone data
        const data = {
            ...otherZoneData,
            coordinates: {
                type: 'Polygon',
                coordinates: polygonCoordinates
            },
            postcodes: normalizedPostcodes,
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
                const targetCityId = otherZoneData.cityId || existingZone.cityId;
                await this.validatePostcodesByCity(postcodesArray, targetCityId);

                // Check for duplicate postcodes (exclude current zone)
                await this.checkDuplicatePostcodes(postcodesArray, zoneId);

                console.log('🔄 Regenerating polygon from postcodes for zone:', zoneId);
                const postcodeCoordinates = await this.fetchPostcodeCoordinates(postcodesArray);
                const polygonCoordinates = await this.createPolygonFromPostcodes(postcodeCoordinates);
                console.log('📍 New polygon coordinates structure:', JSON.stringify(polygonCoordinates, null, 2));
                otherZoneData.coordinates = {
                    type: 'Polygon',
                    coordinates: polygonCoordinates
                };
                otherZoneData.postcodes = postcodesArray.map(pc => this.normalizePostcode(pc));
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

