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

        const maxSort = await addOnCategory.max('sortOrder');
        const created = await addOnCategory.create({
            name: trimmedName,
            status: status === undefined ? true : Boolean(status),
            sortOrder: (Number(maxSort) || 0) + 1,
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
                    attributes: ['id', 'name', 'price', 'addOnCategoryId', 'sortOrder'],
                }
            ]
            : [];

        const order = [
            ['sortOrder', 'ASC'],
            ['id', 'ASC'],
        ];
        if (includeServices) {
            order.push(
                [{ model: addOnServices, as: 'addOnServices' }, 'sortOrder', 'ASC'],
                [{ model: addOnServices, as: 'addOnServices' }, 'id', 'ASC']
            );
        }

        const rows = await addOnCategory.findAll({
            include,
            order,
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
                    attributes: ['id', 'name', 'price', 'addOnCategoryId', 'sortOrder'],
                }
            ],
            order: [
                [{ model: addOnServices, as: 'addOnServices' }, 'sortOrder', 'ASC'],
                [{ model: addOnServices, as: 'addOnServices' }, 'id', 'ASC'],
            ],
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
        const { name, status, sortOrder } = data;

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

        const payload = {
            name: nextName,
            status: status === undefined ? row.status : Boolean(status),
        };
        if (sortOrder !== undefined && !Number.isNaN(Number(sortOrder))) {
            payload.sortOrder = Number(sortOrder);
        }

        await row.update(payload);

        await row.reload();
        return row;
    }

    /**
     * @param {Array<{ addOnCategoryId: number|string, sortOrder: number }>} items
     */
    async updateCategoriesSortOrder(items) {
        if (!Array.isArray(items) || items.length === 0) {
            throw new ValidationError('Provide an array of { addOnCategoryId, sortOrder }');
        }

        await Promise.all(
            items.map(({ addOnCategoryId, sortOrder }) =>
                addOnCategory.update(
                    { sortOrder: Number(sortOrder) },
                    { where: { id: addOnCategoryId } }
                )
            )
        );

        return { updated: items.length };
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
