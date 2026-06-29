const { addOnCategory, addOnServices } = require('../../models');
const { Op } = require('sequelize');

const {
    ValidationError,
    NotFoundError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');

class AddOnCategoryService {
    /**
     * @param {{ name: string, status?: boolean }} data
     */
    async createCategory(data) {
        const { name, status } = data;

        if (!name || String(name).trim() === '') {
            throw new ValidationError('Name is required');
        }

        const trimmedName = String(name).trim();

        const existing = await addOnCategory.findOne({
            where: { name: trimmedName }
        });
        if (existing) {
            throw new ConflictError('Add-on category with this name already exists');
        }

        const created = await addOnCategory.create({
            name: trimmedName,
            status: status === undefined ? true : Boolean(status)
        });

        return created;
    }

    /**
     * List categories, optionally with their add-on services nested.
     * @param {{ includeServices?: boolean }} [options]
     */
    async getAllCategories(options = {}) {
        const { includeServices = true } = options;

        const include = includeServices
            ? [
                {
                    model: addOnServices,
                    as: 'addOnServices',
                    required: false,
                    attributes: ['id', 'name', 'price', 'addOnCategoryId']
                }
            ]
            : [];

        const rows = await addOnCategory.findAll({
            include,
            order: [['name', 'ASC']]
        });

        return rows;
    }

    async getCategoryById(categoryId) {
        if (!categoryId) {
            throw new ValidationError('Category ID is required');
        }

        const row = await addOnCategory.findByPk(categoryId, {
            include: [
                {
                    model: addOnServices,
                    as: 'addOnServices',
                    required: false,
                    attributes: ['id', 'name', 'price', 'addOnCategoryId']
                }
            ]
        });

        if (!row) {
            throw new NotFoundError('Add-on category not found');
        }

        return row;
    }

    /**
     * @param {number|string} categoryId
     * @param {{ name?: string, status?: boolean }} data
     */
    async updateCategory(categoryId, data) {
        const { name, status } = data;

        if (!categoryId) {
            throw new ValidationError('Category ID is required');
        }

        const row = await addOnCategory.findByPk(categoryId);
        if (!row) {
            throw new NotFoundError('Add-on category not found');
        }

        const nextName = name !== undefined ? String(name).trim() : row.name;
        if (!nextName) {
            throw new ValidationError('Name cannot be empty');
        }

        if (name !== undefined) {
            const duplicate = await addOnCategory.findOne({
                where: {
                    name: nextName,
                    id: { [Op.ne]: categoryId }
                }
            });
            if (duplicate) {
                throw new ConflictError('Add-on category with this name already exists');
            }
        }

        await row.update({
            name: nextName,
            status: status === undefined ? row.status : Boolean(status)
        });

        await row.reload();
        return row;
    }

    async deleteCategory(categoryId) {
        if (!categoryId) {
            throw new ValidationError('Category ID is required');
        }

        const row = await addOnCategory.findByPk(categoryId);
        if (!row) {
            throw new NotFoundError('Add-on category not found');
        }

        // Detach add-on services so they are not orphaned by the soft delete
        await addOnServices.update(
            { addOnCategoryId: null },
            { where: { addOnCategoryId: categoryId } }
        );

        await row.destroy();

        return { message: 'Add-on category deleted successfully' };
    }
}

module.exports = new AddOnCategoryService();
