const { addOnServices, addOnCategory, subCategories } = require('../../models');
const { Op } = require('sequelize');

const {
    ValidationError,
    NotFoundError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');

const CATEGORY_INCLUDE = {
    model: addOnCategory,
    as: 'category',
    required: false,
    attributes: ['id', 'name', 'status']
};

// Same as CATEGORY_INCLUDE but also carries the sub-categories (items) the
// category is linked to, so clients can map each item -> its add-on services.
const CATEGORY_INCLUDE_WITH_LINKS = {
    model: addOnCategory,
    as: 'category',
    required: false,
    attributes: ['id', 'name', 'status'],
    include: [{
        model: subCategories,
        as: 'subCategories',
        attributes: ['id'],
        through: { attributes: [] }
    }]
};

async function assertCategoryExists(addOnCategoryId) {
    const category = await addOnCategory.findByPk(addOnCategoryId);
    if (!category) {
        throw new NotFoundError('Add-on category not found');
    }
    return category;
}

class AddOnServicesService {
    /**
     * @param {{ name: string, price: number|string, addOnCategoryId?: number|string }} data
     */
    async createAddOnService(data) {
        const { name, price, addOnCategoryId } = data;

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

        let categoryId = null;
        if (addOnCategoryId !== undefined && addOnCategoryId !== null && addOnCategoryId !== '') {
            categoryId = Number(addOnCategoryId);
            if (!Number.isInteger(categoryId) || categoryId <= 0) {
                throw new ValidationError('addOnCategoryId must be a valid category ID');
            }
            await assertCategoryExists(categoryId);
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
            price: numericPrice,
            addOnCategoryId: categoryId
        });

        return this.getAddOnServiceById(created.id);
    }

    /**
     * @param {{ addOnCategoryId?: number|string }} [filters]
     */
    async getAllAddOnServices(filters = {}) {
        const where = {};
        const { addOnCategoryId } = filters;

        if (addOnCategoryId !== undefined && addOnCategoryId !== null && addOnCategoryId !== '') {
            const categoryId = Number(addOnCategoryId);
            if (!Number.isInteger(categoryId) || categoryId <= 0) {
                throw new ValidationError('addOnCategoryId must be a valid category ID');
            }
            where.addOnCategoryId = categoryId;
        }

        const rows = await addOnServices.findAll({
            where,
            include: [CATEGORY_INCLUDE_WITH_LINKS],
            order: [['createdAt', 'DESC']]
        });
        return rows;
    }

    async getAddOnServiceById(addOnServiceId) {
        if (!addOnServiceId) {
            throw new ValidationError('Add-on service ID is required');
        }

        const row = await addOnServices.findByPk(addOnServiceId, {
            include: [CATEGORY_INCLUDE]
        });

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
        const { name, price, addOnCategoryId } = data;

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

        let nextCategoryId = row.addOnCategoryId;
        if (addOnCategoryId !== undefined) {
            if (addOnCategoryId === null || addOnCategoryId === '') {
                nextCategoryId = null;
            } else {
                const categoryId = Number(addOnCategoryId);
                if (!Number.isInteger(categoryId) || categoryId <= 0) {
                    throw new ValidationError('addOnCategoryId must be a valid category ID');
                }
                await assertCategoryExists(categoryId);
                nextCategoryId = categoryId;
            }
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
            price: nextPrice,
            addOnCategoryId: nextCategoryId
        });

        return this.getAddOnServiceById(addOnServiceId);
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
