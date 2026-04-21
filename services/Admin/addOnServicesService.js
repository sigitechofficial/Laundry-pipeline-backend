const { addOnServices } = require('../../models');
const { Op } = require('sequelize');

const {
    ValidationError,
    NotFoundError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');

class AddOnServicesService {
    /**
     * @param {{ name: string, price: number|string }} data
     */
    async createAddOnService(data) {
        const { name, price } = data;

        if (!name || String(name).trim() === '') {
            throw new ValidationError('Name is required');
        }
        if (price === undefined || price === null || price === '') {
            throw new ValidationError('Price is required');
        }

        const numericPrice = Number(price);
        if (Number.isNaN(numericPrice) || numericPrice < 0) {
            throw new ValidationError('Price must be a valid non-negative number');
        }

        const trimmedName = String(name).trim();

        const existing = await addOnServices.findOne({
            where: { name: trimmedName }
        });

        if (existing) {
            throw new ConflictError('Add-on service with this name already exists');
        }

        const created = await addOnServices.create({
            name: trimmedName,
            price: numericPrice
        });

        return created;
    }

    async getAllAddOnServices() {
        const rows = await addOnServices.findAll({
            order: [['createdAt', 'DESC']]
        });
        return rows;
    }

    async getAddOnServiceById(addOnServiceId) {
        if (!addOnServiceId) {
            throw new ValidationError('Add-on service ID is required');
        }

        const row = await addOnServices.findByPk(addOnServiceId);

        if (!row) {
            throw new NotFoundError('Add-on service not found');
        }

        return row;
    }

    /**
     * @param {number|string} addOnServiceId
     * @param {{ name?: string, price?: number|string }} data
     */
    async updateAddOnService(addOnServiceId, data) {
        const { name, price } = data;

        if (!addOnServiceId) {
            throw new ValidationError('Add-on service ID is required');
        }

        const row = await addOnServices.findByPk(addOnServiceId);

        if (!row) {
            throw new NotFoundError('Add-on service not found');
        }

        const nextName = name !== undefined ? String(name).trim() : row.name;
        if (!nextName) {
            throw new ValidationError('Name cannot be empty');
        }

        let nextPrice = row.price;
        if (price !== undefined && price !== null && price !== '') {
            const numericPrice = Number(price);
            if (Number.isNaN(numericPrice) || numericPrice < 0) {
                throw new ValidationError('Price must be a valid non-negative number');
            }
            nextPrice = numericPrice;
        }

        if (name !== undefined) {
            const duplicate = await addOnServices.findOne({
                where: {
                    name: nextName,
                    id: { [Op.ne]: addOnServiceId }
                }
            });
            if (duplicate) {
                throw new ConflictError('Add-on service with this name already exists');
            }
        }

        await row.update({
            name: nextName,
            price: nextPrice
        });

        await row.reload();
        return row;
    }

    async deleteAddOnService(addOnServiceId) {
        if (!addOnServiceId) {
            throw new ValidationError('Add-on service ID is required');
        }

        const row = await addOnServices.findByPk(addOnServiceId);

        if (!row) {
            throw new NotFoundError('Add-on service not found');
        }

        await row.destroy();

        return { message: 'Add-on service deleted successfully' };
    }
}

module.exports = new AddOnServicesService();
