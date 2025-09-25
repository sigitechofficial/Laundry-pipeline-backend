const { vehicleType, vehicleMake, vehicleModel } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

class VehicleManagementService {
    /**
     * Add a new vehicle type
     * @param {Object} vehicleData - Vehicle data containing title, baseRate, perUnitRate, etc.
     * @returns {Object} Created vehicle data
     */
    async addVehicle(vehicleData) {
        try {
            const { title, baseRate, perUnitRate, weightCapacity, volumeCapacity, image } = vehicleData;
            
            // Check if vehicle already exists
            const vehicleExist = await vehicleType.findOne({
                where: { title, status: true }
            });
            
            if (vehicleExist) {
                throw new ValidationError('A vehicle with the same name already exists');
            }

            const vehicleCreate = await vehicleType.create({
                title,
                baseRate,
                perUnitRate,
                weightCapacity,
                volumeCapacity,
                image,
                status: true
            });
            
            return vehicleCreate;
        } catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new Error(`Add vehicle error: ${error.message}`);
        }
    }

    /**
     * Get all vehicle types
     * @returns {Array} List of all vehicle types
     */
    async getVehicles() {
        try {
            const getVehicles = await vehicleType.findAll({
                where: { status: true },
                order: [['createdAt', 'DESC']]
            });
            return getVehicles;
        } catch (error) {
            throw new Error(`Get vehicles error: ${error.message}`);
        }
    }

    /**
     * Update vehicle type
     * @param {number} vehicleId - Vehicle ID
     * @param {Object} updateData - Vehicle update data
     * @returns {Object} Updated vehicle data
     */
    async updateVehicle(vehicleId, updateData) {
        try {
            const { title, baseRate, perUnitRate, weightCapacity, volumeCapacity, image } = updateData;
            
            const vehicleExists = await vehicleType.findOne({ where: { id: vehicleId } });
            if (!vehicleExists) {
                throw new NotFoundError('Vehicle not found');
            }

            const updatedVehicle = await vehicleType.update(
                { title, baseRate, perUnitRate, weightCapacity, volumeCapacity, image },
                { where: { id: vehicleId } }
            );

            if (!updatedVehicle[0]) {
                throw new Error('Failed to update vehicle');
            }

            const updatedVehicleData = await vehicleType.findOne({ where: { id: vehicleId } });
            return updatedVehicleData;
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Update vehicle error: ${error.message}`);
        }
    }

    /**
     * Delete vehicle type (soft delete)
     * @param {number} vehicleId - Vehicle ID
     * @returns {Object} Deleted vehicle data
     */
    async deleteVehicle(vehicleId) {
        try {
            const vehicleToDelete = await vehicleType.destroy({ where: { id: vehicleId } });
            
            if (!vehicleToDelete) {
                throw new NotFoundError('Vehicle not found');
            }
            
            return { message: 'Vehicle deleted successfully' };
        } catch (error) {
            if (error instanceof NotFoundError) {
                throw error;
            }
            throw new Error(`Delete vehicle error: ${error.message}`);
        }
    }

    /**
     * Add vehicle make
     * @param {Object} makeData - Make data containing name
     * @returns {Object} Created make data
     */
    async addVehicleMake(makeData) {
        try {
            const { name } = makeData;
            
            const makeCreate = await vehicleMake.create({ name });
            return makeCreate;
        } catch (error) {
            throw new Error(`Add vehicle make error: ${error.message}`);
        }
    }

    /**
     * Get all vehicle makes
     * @returns {Array} List of all vehicle makes
     */
    async getVehicleMakes() {
        try {
            const getMakes = await vehicleMake.findAll({
                order: [['createdAt', 'DESC']]
            });
            return getMakes;
        } catch (error) {
            throw new Error(`Get vehicle makes error: ${error.message}`);
        }
    }

    /**
     * Add vehicle model
     * @param {Object} modelData - Model data containing name and makeId
     * @returns {Object} Created model data
     */
    async addVehicleModel(modelData) {
        try {
            const { name, makeId } = modelData;
            
            const modelCreate = await vehicleModel.create({ name, makeId });
            return modelCreate;
        } catch (error) {
            throw new Error(`Add vehicle model error: ${error.message}`);
        }
    }

    /**
     * Get all vehicle models
     * @returns {Array} List of all vehicle models
     */
    async getVehicleModels() {
        try {
            const getModels = await vehicleModel.findAll({
                include: [
                    {
                        model: vehicleMake,
                        attributes: ['name']
                    }
                ],
                order: [['createdAt', 'DESC']]
            });
            return getModels;
        } catch (error) {
            throw new Error(`Get vehicle models error: ${error.message}`);
        }
    }
}

module.exports = new VehicleManagementService();
