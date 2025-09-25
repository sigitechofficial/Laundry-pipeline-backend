const { countries, cities } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

class LocationManagementService {
    /**
     * Add a new country
     * @param {Object} countryData - Country data containing name and code
     * @returns {Object} Created country data
     */
    async addCountry(countryData) {
        try {
            const { name, code } = countryData;
            
            // Check if country already exists
            const countryExists = await countries.findOne({
                where: { name }
            });
            
            if (countryExists) {
                throw new ValidationError('Country with this name already exists');
            }

            const countryCreate = await countries.create({
                name,
                code
            });
            
            return countryCreate;
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Add country error: ${error.message}`);
        }
    }

    /**
     * Get all countries
     * @returns {Array} List of all countries
     */
    async getCountries() {
        try {
            const getCountries = await countries.findAll({
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
     * @param {Object} updateData - Country update data
     * @returns {Object} Updated country data
     */
    async updateCountry(countryId, updateData) {
        try {
            const { name, code } = updateData;
            
            const countryExists = await countries.findOne({ where: { id: countryId } });
            if (!countryExists) {
                throw new NotFoundError('Country not found');
            }

            const updatedCountry = await countries.update(
                { name, code },
                { where: { id: countryId } }
            );

            if (!updatedCountry[0]) {
                throw new Error('Failed to update country');
            }

            const updatedCountryData = await countries.findOne({ where: { id: countryId } });
            return updatedCountryData;
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Update country error: ${error.message}`);
        }
    }

    /**
     * Delete country
     * @param {number} countryId - Country ID
     * @returns {Object} Deleted country data
     */
    async deleteCountry(countryId) {
        try {
            const countryToDelete = await countries.destroy({ where: { id: countryId } });
            
            if (!countryToDelete) {
                throw new NotFoundError('Country not found');
            }
            
            return { message: 'Country deleted successfully' };
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
            const { name, countryId } = cityData;
            
            // Check if city already exists for this country
            const cityExists = await cities.findOne({
                where: { name, countryId }
            });
            
            if (cityExists) {
                throw new ValidationError('City with this name already exists in this country');
            }

            const cityCreate = await cities.create({
                name,
                countryId
            });
            
            return cityCreate;
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Add city error: ${error.message}`);
        }
    }

    /**
     * Get all cities
     * @param {number} countryId - Optional country ID to filter cities
     * @returns {Array} List of all cities or cities for specific country
     */
    async getCities(countryId = null) {
        try {
            const whereClause = countryId ? { countryId } : {};
            
            const getCities = await cities.findAll({
                where: whereClause,
                include: [
                    {
                        model: countries,
                        attributes: ['name', 'code']
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
     * @param {Object} updateData - City update data
     * @returns {Object} Updated city data
     */
    async updateCity(cityId, updateData) {
        try {
            const { name, countryId } = updateData;
            
            const cityExists = await cities.findOne({ where: { id: cityId } });
            if (!cityExists) {
                throw new NotFoundError('City not found');
            }

            const updatedCity = await cities.update(
                { name, countryId },
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
                        attributes: ['name', 'code']
                    }
                ]
            });
            return updatedCityData;
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Update city error: ${error.message}`);
        }
    }

    /**
     * Delete city
     * @param {number} cityId - City ID
     * @returns {Object} Deleted city data
     */
    async deleteCity(cityId) {
        try {
            const cityToDelete = await cities.destroy({ where: { id: cityId } });
            
            if (!cityToDelete) {
                throw new NotFoundError('City not found');
            }
            
            return { message: 'City deleted successfully' };
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Delete city error: ${error.message}`);
        }
    }
}

module.exports = new LocationManagementService();
