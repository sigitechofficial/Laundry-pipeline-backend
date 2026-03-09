const { countries, cities } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { Op } = require('sequelize');

class LocationManagementService {
    /**
     * Add a new country
     * @param {Object} countryData - Country data containing name and code
     * @returns {Object} Created country data
     */
    async addCountry(countryData) {
        try {
            // Check if country already exists and is NOT deleted
            const countryExists = await countries.findOne({
                where: {
                    name: countryData.name,
                    deletedAt: { [Op.is]: null }
                }
            });
            
            if (countryExists) {
                throw new ValidationError('Country with this name already exists');
            }

            const countryCreate = await countries.create(countryData);
            
            return countryCreate;
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Add country error: ${error.message}`);
        }
    }

    /**
     * Get all countries (excluding soft deleted)
     * @returns {Array} List of all active countries
     */
    async getCountries() {
        try {
            const getCountries = await countries.findAll({
                where: {
                    deletedAt: { [Op.is]: null }
                },
                order: [['createdAt', 'DESC']]
            });
            return getCountries;
        } catch (error) {
            throw new Error(`Get countries error: ${error.message}`);
        }
    }

    /**
     * Update country
     * @param {number} countryId - Country ID
     * @param {Object} updateData - Country update data (name, shortName, image, status)
     * @returns {Object} Updated country data
     */
    async updateCountry(countryId, updateData) {
        try {
            const countryExists = await countries.findOne({ 
                where: { 
                    id: countryId,
                    deletedAt: { [Op.is]: null }
                } 
            });
            if (!countryExists) {
                throw new NotFoundError('Country not found');
            }

            // Only update fields that are provided and exist in the model
            const allowedFields = ['name', 'shortName', 'image', 'status'];
            const updateFields = {};
            
            Object.keys(updateData).forEach(key => {
                if (allowedFields.includes(key) && updateData[key] !== undefined) {
                    updateFields[key] = updateData[key];
                }
            });

            if (Object.keys(updateFields).length === 0) {
                throw new ValidationError('No valid fields to update');
            }

            const updatedCountry = await countries.update(
                updateFields,
                { where: { id: countryId } }
            );

            if (!updatedCountry[0]) {
                throw new Error('Failed to update country');
            }

            const updatedCountryData = await countries.findOne({ where: { id: countryId } });
            return updatedCountryData;
        } catch (error) {
            if (error instanceof NotFoundError || error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Update country error: ${error.message}`);
        }
    }

    /**
     * Soft delete country
     * @param {number} countryId - Country ID
     * @returns {Object} Deleted country data
     */
    async deleteCountry(countryId) {
        try {
            // Check if country exists and is not already deleted
            const countryExists = await countries.findOne({
                where: {
                    id: countryId,
                    deletedAt: { [Op.is]: null }
                }
            });

            if (!countryExists) {
                throw new NotFoundError('Country not found or already deleted');
            }

            // Soft delete by setting deletedAt timestamp
            await countries.update(
                { deletedAt: new Date() },
                { where: { id: countryId } }
            );
            
            return { 
                message: 'Country deleted successfully',
                deletedAt: new Date()
            };
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Delete country error: ${error.message}`);
        }
    }

    /**
     * Add a new city
     * @param {Object} cityData - City data containing name and countryId
     * @returns {Object} Created city data
     */
    async addCity(cityData) {
        try {
            // Check if city already exists for this country and is NOT deleted
            const cityExists = await cities.findOne({
                where: {
                    name: cityData.name,
                    countryId: cityData.countryId,
                    deletedAt: { [Op.is]: null }
                }
            });
            
            if (cityExists) {
                throw new ValidationError('City with this name already exists in this country');
            }

            const cityCreate = await cities.create(cityData);
            
            return cityCreate;
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Add city error: ${error.message}`);
        }
    }

    /**
     * Get all cities (excluding soft deleted)
     * @param {number} countryId - Optional country ID to filter cities
     * @returns {Array} List of all active cities or cities for specific country
     */
    async getCities(countryId = null) {
        try {
            const whereClause = countryId 
                ? { countryId, deletedAt: { [Op.is]: null } } 
                : { deletedAt: { [Op.is]: null } };
            
            const getCities = await cities.findAll({
                where: whereClause,
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName', 'image', 'status'],
                        where: { deletedAt: { [Op.is]: null } }
                    }
                ],
                order: [['createdAt', 'DESC']]
            });
            return getCities;
        } catch (error) {
            throw new Error(`Get cities error: ${error.message}`);
        }
    }

    /**
     * Update city
     * @param {number} cityId - City ID
     * @param {Object} updateData - City update data (name, lat, lng, status, countryId)
     * @returns {Object} Updated city data
     */
    async updateCity(cityId, updateData) {
        try {
            const cityExists = await cities.findOne({ 
                where: { 
                    id: cityId,
                    deletedAt: { [Op.is]: null }
                } 
            });
            if (!cityExists) {
                throw new NotFoundError('City not found');
            }

            // Only update fields that are provided and exist in the model
            const allowedFields = ['name', 'lat', 'lng', 'status', 'countryId'];
            const updateFields = {};
            
            Object.keys(updateData).forEach(key => {
                if (allowedFields.includes(key) && updateData[key] !== undefined) {
                    updateFields[key] = updateData[key];
                }
            });

            if (Object.keys(updateFields).length === 0) {
                throw new ValidationError('No valid fields to update');
            }

            // If countryId is being updated, verify it exists and is not deleted
            if (updateFields.countryId) {
                const countryExists = await countries.findOne({ 
                    where: { 
                        id: updateFields.countryId,
                        deletedAt: { [Op.is]: null }
                    } 
                });
                if (!countryExists) {
                    throw new ValidationError('Invalid country ID or country has been deleted');
                }
            }

            const updatedCity = await cities.update(
                updateFields,
                { where: { id: cityId } }
            );

            if (!updatedCity[0]) {
                throw new Error('Failed to update city');
            }

            const updatedCityData = await cities.findOne({ 
                where: { id: cityId },
                include: [
                    {
                        model: countries,
                        attributes: ['id', 'name', 'shortName', 'image', 'status']
                    }
                ]
            });
            return updatedCityData;
        } catch (error) {
            if (error instanceof NotFoundError || error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Update city error: ${error.message}`);
        }
    }

    /**
     * Soft delete city
     * @param {number} cityId - City ID
     * @returns {Object} Deleted city data
     */
    async deleteCity(cityId) {
        try {
            // Check if city exists and is not already deleted
            const cityExists = await cities.findOne({
                where: {
                    id: cityId,
                    deletedAt: { [Op.is]: null }
                }
            });

            if (!cityExists) {
                throw new NotFoundError('City not found or already deleted');
            }

            // Soft delete by setting deletedAt timestamp
            await cities.update(
                { deletedAt: new Date() },
                { where: { id: cityId } }
            );
            
            return { 
                message: 'City deleted successfully',
                deletedAt: new Date()
            };
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Delete city error: ${error.message}`);
        }
    }
}

module.exports = new LocationManagementService();
