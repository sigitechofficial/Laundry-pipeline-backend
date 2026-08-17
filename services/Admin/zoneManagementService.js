const { zone, cities, bussinessInformation, units, users, sequelize } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

function normalizeZonePostcodes(raw) {
    let list = raw;
    if (typeof list === 'string') {
        const trimmed = list.trim();
        if (!trimmed) return [];
        try {
            list = JSON.parse(trimmed);
        } catch (e) {
            list = trimmed.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
        }
    }
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const pc = String(item ?? '').trim();
        if (!pc) continue;
        const key = pc.replace(/\s+/g, '').toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(pc);
    }
    return out;
}

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
                order: [['createdAt', 'DESC']],
                include: [
                    {
                        model: units,
                        as: 'currencyUnitZ',
                        attributes: ['id', 'name', 'symbol', 'type'],
                        required: false
                    },
                    {
                        model: cities,
                        attributes: ['id', 'name'],
                        required: false
                    },
                    {
                        model: users,
                        as: 'zoneAdmin',
                        attributes: ['id', 'firstName', 'lastName', 'email'],
                        required: false
                    }
                ]
            });

            const [shopCountRows] = await sequelize.query(`
                SELECT a.zoneId AS zoneId, COUNT(b.id) AS shops
                FROM bussinessInformations b
                INNER JOIN addressDbs a ON a.id = b.shopAddressId
                WHERE a.zoneId IS NOT NULL
                  AND a.deletedAt IS NULL
                  AND b.deletedAt IS NULL
                GROUP BY a.zoneId
            `);
            const shopCountByZone = new Map(
                (shopCountRows || []).map((row) => [
                    Number(row.zoneId),
                    Number(row.shops) || 0,
                ])
            );

            const shapedZones = getZones.map((row) => {
                const plain = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
                plain.postcodes = normalizeZonePostcodes(plain.postcodes);
                plain.shopCount = shopCountByZone.get(Number(plain.id)) || 0;
                return plain;
            });

            const totalZones = await zone.count({
                where: { status: true }
            });

            const totalCities = await cities.count();

            const totalShops = await bussinessInformation.count();

            return {
                zones: shapedZones,
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
                attributes,
                include: [
                    {
                        model: units,
                        as: 'currencyUnitZ',
                        attributes: ['id', 'name', 'symbol', 'type'],
                        required: false
                    }
                ]
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
