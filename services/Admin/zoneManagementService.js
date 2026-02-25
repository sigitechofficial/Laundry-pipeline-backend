const { zone, cities, bussinessInformation } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

class ZoneManagementService {
    /**
     * Add a new zone
     * @param {Object} zoneData - Zone data containing name, description, and coordinates
     * @returns {Object} Created zone data
     */
    async addZone(zoneData) {
            const zoneCreate = await zone.create(zoneData);
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
     * Get a zone by id with optional selected columns
     * @param {number} zoneId - Zone ID
     * @param {string[]} columns - Optional list of columns to select
     * @returns {Object} Zone data
     */
    async getZoneById(zoneId, columns = []) {
            const allowedColumns = Object.keys(zone.rawAttributes);

            let attributes = allowedColumns;
            if (Array.isArray(columns) && columns.length > 0) {
                const invalidColumns = columns.filter((column) => !allowedColumns.includes(column));
                if (invalidColumns.length > 0) {
                    throw new ValidationError(`Invalid column(s): ${invalidColumns.join(', ')}`);
                }
                attributes = columns;
            }

            const zoneData = await zone.findOne({
                where: { id: zoneId },
                attributes
            });

            if (!zoneData) {
                throw new NotFoundError('Zone not found');
            }

            return zoneData;
    }

    /**
     * Update zone
     * @param {number} zoneId - Zone ID
     * @param {Object} updateData - Zone update data
     * @returns {Object} Updated zone data
     */
    async updateZone(zoneId, updateData) {
            const zoneExists = await zone.findOne({ where: { id: zoneId } });
            if (!zoneExists) {
                throw new NotFoundError('Zone not found');
            }

            const updatedZone = await zone.update(
                updateData,
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
