const { zone, cities, bussinessInformation } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

class ZoneManagementService {
    /**
     * Add a new zone
     * @param {Object} zoneData - Zone data containing name, description, and coordinates
     * @returns {Object} Created zone data
     */
    async addZone(zoneData) {
            const { name, description, coordinates } = zoneData;
            
            const zoneCreate = await zone.create({
                name,
                description,
                coordinates
            });
            
            return zoneCreate;
    }

    /**
     * Get all zones with statistics
     * @returns {Object} List of zones with total counts
     */
    async getZones() {
            const getZones = await zone.findAll({
                where: { status: true },
                order: [['createdAt', 'DESC']]
            });

            const totalZones = await zone.count({
                where: { status: true }
            });

            const totalCities = await cities.count();

            const totalShops = await bussinessInformation.count();

            return {
                zones: getZones,
                totalZones,
                totalCities,
                totalShops
            };
    }

    /**
     * Update zone
     * @param {number} zoneId - Zone ID
     * @param {Object} updateData - Zone update data
     * @returns {Object} Updated zone data
     */
    async updateZone(zoneId, updateData) {
            const { name, description, coordinates } = updateData;
            
            const zoneExists = await zone.findOne({ where: { id: zoneId } });
            if (!zoneExists) {
                throw new NotFoundError('Zone not found');
            }

            const updatedZone = await zone.update(
                { name, description, coordinates },
                { where: { id: zoneId } }
            );

            if (!updatedZone[0]) {
                throw new Error('Failed to update zone');
            }

            const updatedZoneData = await zone.findOne({ where: { id: zoneId } });
            return updatedZoneData;
    }

    /**
     * Delete zone (soft delete)
     * @param {number} zoneId - Zone ID
     * @returns {Object} Deleted zone data
     */
    async deleteZone(zoneId) {
            const zoneToDelete = await zone.destroy({ where: { id: zoneId } });
            
            if (!zoneToDelete) {
                throw new NotFoundError('Zone not found');
            }
            
            return { message: 'Zone deleted successfully' };
    }
}

module.exports = new ZoneManagementService();
