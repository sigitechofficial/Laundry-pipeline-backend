const {
    subCategories,
    categories,
    service,
    serviceCategories,
    preferenceTypes,
    preferenceValues,
    serviceWithPreferences,
    customerSelectedService,
    addOnCategory } = require('../../models');
const sequelize = require('sequelize');
const { literal, fn, col, Op } = require("sequelize");

const {
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');

function normalizeAddOnCategoryIds(value) {
    if (value == null) return [];
    let arr = value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            const parsed = JSON.parse(trimmed);
            arr = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            arr = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
        }
    } else if (!Array.isArray(value)) {
        arr = [value];
    }
    const ids = arr
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0);
    return [...new Set(ids)];
}

function sortBySortOrder(rows = []) {
    return [...rows].sort((a, b) => {
        const ao = Number(a?.sortOrder ?? 0);
        const bo = Number(b?.sortOrder ?? 0);
        if (ao !== bo) return ao - bo;
        return Number(a?.id ?? 0) - Number(b?.id ?? 0);
    });
}

function parseServiceBoolean(value) {
    if (value === undefined || value === null || value === '') return undefined;
    return value === true || value === 'true' || value === 1 || value === '1';
}

const SERVICE_WRITABLE_FIELDS = [
    'name',
    'description',
    'image',
    'timeRequired',
    'pricingBasis',
    'numberOfBags',
    'numberOfItems',
    'washBleedDisclaimerEnabled',
    'sortOrder',
    'status',
];

function pickServiceWritableFields(serviceData) {
    const data = {};
    for (const key of SERVICE_WRITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(serviceData, key)) {
            data[key] = serviceData[key];
        }
    }
    return normalizeServicePayload(data);
}

function normalizeServicePayload(serviceData) {
    const data = { ...serviceData };
    if (data.numberOfBags !== undefined) {
        data.numberOfBags = parseServiceBoolean(data.numberOfBags);
    }
    if (data.numberOfItems !== undefined) {
        data.numberOfItems = parseServiceBoolean(data.numberOfItems);
    }
    if (data.washBleedDisclaimerEnabled !== undefined) {
        data.washBleedDisclaimerEnabled = parseServiceBoolean(
            data.washBleedDisclaimerEnabled
        );
    }
    return data;
}

class ServiceManagementService {
    /**
     * Keep serviceCategories junction in sync when category.serviceId is set.
     */
    async syncServiceCategoryLink(serviceId, categoryId) {
        if (!serviceId || !categoryId) return;

        const existing = await serviceCategories.findOne({
            where: { serviceId, categoryId },
        });

        if (!existing) {
            await serviceCategories.create({
                serviceId,
                categoryId,
                status: true,
            });
            return;
        }

        if (!existing.status) {
            await existing.update({ status: true });
        }
    }

    /**
     * Build serviceCategoriesData payload for admin/customer UIs.
     */
    async getServiceCategoriesDataForService(serviceId) {
        const numericServiceId = Number(serviceId);
        if (!numericServiceId || Number.isNaN(numericServiceId)) {
            throw new ValidationError('Valid serviceId is required');
        }

        const directCategories = await categories.findAll({
            where: {
                serviceId: numericServiceId,
                status: true,
            },
            attributes: ['id', 'name', 'description', 'serviceId', 'sortOrder'],
            include: [
                {
                    model: subCategories,
                    attributes: ['id', 'name', 'price', 'status', 'description', 'unitCount', 'sortOrder'],
                    where: { status: true },
                    required: false,
                },
            ],
            order: [
                ['sortOrder', 'ASC'],
                ['id', 'ASC'],
                [subCategories, 'sortOrder', 'ASC'],
                [subCategories, 'id', 'ASC'],
            ],
        });

        const junctionRows = await serviceCategories.findAll({
            where: { serviceId: numericServiceId, status: true },
            include: [
                {
                    model: categories,
                    where: { status: true },
                    required: true,
                    attributes: ['id', 'name', 'description', 'serviceId', 'sortOrder'],
                    include: [
                        {
                            model: subCategories,
                            attributes: ['id', 'name', 'price', 'status', 'description', 'unitCount', 'sortOrder'],
                            where: { status: true },
                            required: false,
                        },
                    ],
                },
            ],
            order: [
                [{ model: categories }, 'sortOrder', 'ASC'],
                [{ model: categories }, 'id', 'ASC'],
            ],
        });

        const seenCategoryIds = new Set();
        const result = [];

        for (const row of directCategories) {
            const cat = row.toJSON();
            seenCategoryIds.add(cat.id);
            result.push({
                id: `svc-cat-${cat.id}`,
                serviceId: numericServiceId,
                categoryId: cat.id,
                status: true,
                category: {
                    id: cat.id,
                    name: cat.name,
                    description: cat.description,
                    sortOrder: cat.sortOrder ?? 0,
                    subCategories: sortBySortOrder(cat.subCategories || []),
                },
            });
        }

        for (const junction of junctionRows) {
            const cat = junction.category?.toJSON
                ? junction.category.toJSON()
                : junction.category;
            if (!cat || seenCategoryIds.has(cat.id)) continue;
            if (
                cat.serviceId != null &&
                Number(cat.serviceId) !== numericServiceId
            ) {
                continue;
            }
            seenCategoryIds.add(cat.id);
            result.push({
                id: junction.id,
                serviceId: numericServiceId,
                categoryId: cat.id,
                status: junction.status,
                category: {
                    id: cat.id,
                    name: cat.name,
                    description: cat.description,
                    sortOrder: cat.sortOrder ?? 0,
                    subCategories: sortBySortOrder(cat.subCategories || []),
                },
            });
        }

        result.sort((a, b) => {
            const ao = Number(a.category?.sortOrder ?? 0);
            const bo = Number(b.category?.sortOrder ?? 0);
            if (ao !== bo) return ao - bo;
            return Number(a.categoryId) - Number(b.categoryId);
        });

        return result;
    }

    /**
     * Get admin services with categories and counts
     * @returns {Object} Services with category counts
     */
    async getAdminServicesWithCategories() {
        const countAndService = await subCategories.findAll({
            attributes: [
                'id',
                [sequelize.fn('COUNT', sequelize.col('categoryId')), 'categorySubItemCount']
            ],
            include: [
                {
                    model: categories,
                    attributes: ['id', 'name', 'status', 'image']
                }
            ],
            group: ['categoryId'],
        });

        return {
            serviceTypes: countAndService
        };
    }


    /**
     * Edit Subcategories
     * @param {number} subCategoryId - Subcategory ID
     * @param {string} name - Subcategory name
     * @param {string} price - Subcategory price
     * @returns {Object} Edited subcategory data
     */
    async editSubcategories(subCategoryId, subCategoryData) {
        const { addOnCategoryIds, excludedAddOnCategoryIds, ...rest } = subCategoryData;
        const editSubcategory = await subCategories.update(rest, { where: { id: subCategoryId } });
        if (!editSubcategory) {
            throw new NotFoundError('Subcategory Not Found')
        }
        // Sync linked add-on categories only when the field was provided.
        if (addOnCategoryIds !== undefined || excludedAddOnCategoryIds !== undefined) {
            const row = await subCategories.findByPk(subCategoryId);
            if (row) {
                if (addOnCategoryIds !== undefined) {
                    await row.setAddOnCategories(normalizeAddOnCategoryIds(addOnCategoryIds));
                }
                if (excludedAddOnCategoryIds !== undefined) {
                    await row.setExcludedAddOnCategories(
                        normalizeAddOnCategoryIds(excludedAddOnCategoryIds)
                    );
                }
            }
        }
        return editSubcategory;
    }

    /**
     * Get subcategories by category ID
     * @param {number} categoryId - Category ID
     * @returns {Object} Subcategories for the category
     */
    async getSubCategories(categoryId) {
            const findData = await subCategories.findAll({
                where: {
                    categoryId: categoryId
                },
                attributes: ['id', 'name', 'price', 'status', 'sortOrder'],
                order: [
                    ['sortOrder', 'ASC'],
                    ['id', 'ASC'],
                ],
            });

            return {
                serviceTypesItems: findData
            };
    }

    /**
     * Get all services and categories for order editing
     * @returns {Object} Services, categories, and service categories
     */
    async getServicesAndCategoriesForOrderEdit() {
            const services = await service.findAll({
                where: { status: true },
                attributes: ['id', 'name', 'description']
            });

            const categoriesData = await categories.findAll({
                where: { status: true },
                attributes: ['id', 'name', 'description'],
                include: [
                    {
                        model: subCategories,
                        attributes: ['id', 'name', 'price'],
                        where: { status: true }
                    }
                ]
            });

            const serviceCategoriesData = await serviceCategories.findAll({
                where: { status: true },
                include: [
                    {
                        model: service,
                        attributes: ['id', 'name']
                    },
                    {
                        model: categories,
                        attributes: ['id', 'name']
                    }
                ]
            });

            return {
                services: services,
                categories: categoriesData,
                serviceCategories: serviceCategoriesData
            };
    }

    /**
     * Get all services with usage counts
     * @returns {Object} List of all active services and service usage counts
     */
    async getAllServices() {
            const getServices = await service.findAll({
                where: {
                    status: true,
                },
                order: [['sortOrder', 'ASC']]
            });

            // Create an object with service names as keys and counts as values
            const servicesCount = {};
            
            // Count usage for each service in parallel for better performance
            const countPromises = getServices.map(async (serviceItem) => {
                const count = await customerSelectedService.count({
                    where: {
                        serviceId: serviceItem.id
                    }
                });
                return { name: serviceItem.name, count };
            });

            const countResults = await Promise.all(countPromises);
            
            // Build the servicesCount object
            countResults.forEach(({ name, count }) => {
                servicesCount[name] = count;
            });

            return { 
                services: getServices,
                servicesCount: servicesCount
            };
    }

    /**
     * Get all categories
     * @returns {Array} List of all categories
     */
    async getCategories(filters = {}) {
            const where = {};
            if (filters.serviceId != null && filters.serviceId !== '') {
                where.serviceId = Number(filters.serviceId);
            }

            return categories.findAll({
                where,
                include: [
                    {
                        model: service,
                        as: 'service',
                        attributes: ['id', 'name'],
                        required: false,
                    },
                    {
                        model: addOnCategory,
                        as: 'addOnCategories',
                        attributes: ['id', 'name'],
                        through: { attributes: [] },
                        required: false,
                    },
                ],
                order: [
                    ['sortOrder', 'ASC'],
                    ['id', 'ASC'],
                ],
            });
    }

    /**
     * Edit Categories
     * @param {number} categoryId - Category ID
     * @param {string} name - Category name
     * @param {string} description - Category description
     * @returns {Object} Edited category data
     */
    async editCategories(categoryId, categoryData) {
        const existing = await categories.findByPk(categoryId);
        if (!existing) {
            throw new NotFoundError('Category Not Found');
        }

        const { addOnCategoryIds, ...rest } = categoryData || {};
        const payload = {};
        const allowedFields = ['name', 'description', 'image', 'serviceId', 'status', 'sortOrder'];
        allowedFields.forEach((field) => {
            if (rest[field] === undefined) return;
            if (field === 'serviceId' && rest[field] === '') return;
            payload[field] = rest[field];
        });

        if (payload.serviceId != null && payload.serviceId !== '') {
            payload.serviceId = Number(payload.serviceId);
            const serviceRow = await service.findByPk(payload.serviceId);
            if (!serviceRow) {
                throw new NotFoundError('Service not found');
            }
        }

        if (Object.keys(payload).length === 0 && addOnCategoryIds === undefined) {
            throw new ValidationError('No valid fields provided to update');
        }

        if (Object.keys(payload).length > 0) {
            await categories.update(payload, { where: { id: categoryId } });
        }

        // Category-level add-on links are inherited by all current and future
        // sub-categories under this category (resolved at read time).
        if (addOnCategoryIds !== undefined) {
            await existing.setAddOnCategories(
                normalizeAddOnCategoryIds(addOnCategoryIds)
            );
        }

        const updated = await categories.findByPk(categoryId, {
            include: [
                {
                    model: service,
                    as: 'service',
                    attributes: ['id', 'name'],
                    required: false,
                },
                {
                    model: addOnCategory,
                    as: 'addOnCategories',
                    attributes: ['id', 'name'],
                    through: { attributes: [] },
                    required: false,
                },
            ],
        });
        if (updated?.serviceId) {
            await this.syncServiceCategoryLink(updated.serviceId, updated.id);
        }

        return updated;
    }
    /**
     * Delete Categories
     * @param {number} categoryId - Category ID
     * @returns {Object} Deleted category data
     */
    async deleteCategories(categoryId) {
        const deleteCategory = await categories.destroy({ where: { id: categoryId } });
        if (!deleteCategory) {
            throw new NotFoundError('Category Not Found')
        }
        return deleteCategory;
    }

    /**
     * Get all subcategories
     * @returns {Array} List of all subcategories
     */
    async getSubcategories() {
            const getSubcategories = await subCategories.findAll({
                include: [{
                    model: addOnCategory,
                    as: 'addOnCategories',
                    attributes: ['id', 'name'],
                    through: { attributes: [] }
                }, {
                    model: addOnCategory,
                    as: 'excludedAddOnCategories',
                    attributes: ['id', 'name'],
                    through: { attributes: [] }
                }],
                order: [
                    ['sortOrder', 'ASC'],
                    ['id', 'ASC'],
                ],
            });

            // Attach inherited add-on categories from the parent catalog category
            // so admin UIs can show them without writing them onto each sub-row.
            // Exclusions opt a subcategory out of that inheritance.
            const categoryIds = [
                ...new Set(
                    getSubcategories
                        .map((row) => Number(row.categoryId))
                        .filter((id) => Number.isInteger(id) && id > 0)
                ),
            ];
            const parentLinks = categoryIds.length
                ? await categories.findAll({
                      where: { id: categoryIds },
                      attributes: ['id'],
                      include: [{
                          model: addOnCategory,
                          as: 'addOnCategories',
                          attributes: ['id', 'name'],
                          through: { attributes: [] },
                          required: false,
                      }],
                  })
                : [];
            const inheritedByCategoryId = new Map(
                parentLinks.map((cat) => [
                    Number(cat.id),
                    (cat.addOnCategories || []).map((a) => ({
                        id: a.id,
                        name: a.name,
                        inherited: true,
                    })),
                ])
            );

            return getSubcategories.map((row) => {
                const plain = row.toJSON();
                const inherited =
                    inheritedByCategoryId.get(Number(plain.categoryId)) || [];
                const directIds = new Set(
                    (plain.addOnCategories || []).map((a) => Number(a.id))
                );
                const excludedIds = new Set(
                    (plain.excludedAddOnCategories || []).map((a) => Number(a.id))
                );
                // Active inherited = parent links not also direct and not opted out.
                plain.inheritedAddOnCategories = inherited.filter(
                    (a) =>
                        !directIds.has(Number(a.id)) &&
                        !excludedIds.has(Number(a.id))
                );
                return plain;
            });
    }

    /**
     * Delete SubCategories
     * @param {number} subCategoryId - Subcategory ID
     * @returns {Object} Deleted subcategory data
     */
    async deleteSubcategories(subCategoryId) {
        const deleteSubcategory = await subCategories.destroy({ where: { id: subCategoryId } });
        if (!deleteSubcategory) {
            throw new NotFoundError('Subcategory Not Found');
        }
        return deleteSubcategory;
    }

    /**
     * Add a new service
     * @param {Object} serviceData - Service data containing name, description, and image
     * @returns {Object} Created service data
     */
    async addService(serviceData) {
            const serviceCreate = await service.create(pickServiceWritableFields(serviceData));
            return serviceCreate;
    }


    /**
     * Add new Category
     * @param {Object} categoryData - Category data containing name, description, and image
     * @returns {Object} Created category data
     */

    async addCategory(categoryData) {
            const serviceId =
                categoryData.serviceId != null && categoryData.serviceId !== ''
                    ? Number(categoryData.serviceId)
                    : null;

            if (!serviceId || Number.isNaN(serviceId)) {
                throw new ValidationError('serviceId is required when creating a category');
            }

            const serviceRow = await service.findByPk(serviceId);
            if (!serviceRow) {
                throw new NotFoundError('Service not found');
            }

            const payload = {
                name: categoryData.name,
                description: categoryData.description,
                image: categoryData.image,
                status:
                    categoryData.status !== undefined ? categoryData.status : true,
                serviceId,
            };

            const maxSort = await categories.max('sortOrder', {
                where: { serviceId },
            });
            payload.sortOrder =
                categoryData.sortOrder != null && !Number.isNaN(Number(categoryData.sortOrder))
                    ? Number(categoryData.sortOrder)
                    : (Number(maxSort) || 0) + 1;

            const categoryCreate = await categories.create(payload);
            await this.syncServiceCategoryLink(serviceId, categoryCreate.id);
            return categoryCreate;
    }


    /** 
     * Get all preference types && service details, Categories, SubCategories
     * @returns {outObj} List of all preference types && service details
     */

    async getAllPreferenceTypesAndServiceDetails(serviceId) {
        console.log("Service Id ====>", serviceId)

        // Fetch mapped preference types for this service (can include parent and/or child types).
        const preferencesData = await serviceWithPreferences.findAll({
            where: { serviceId: serviceId, status: true },
            include: [
                {
                    model: preferenceTypes,
                    attributes: ['id', 'name', 'parentPreferenceTypeId'],
                    where: { status: true },
                    include: [
                        {
                            model: preferenceValues,
                            attributes: ['id', 'value'],
                            where: { status: true },
                            required: false
                        }
                    ]
                }
            ]
        });

        // Build flat map from mapped preference types (deduplicated by type id).
        const mappedTypes = preferencesData
            .filter(row => row.preferenceType)
            .map(row => row.preferenceType.toJSON());
        const typeMap = new Map(mappedTypes.map(type => [type.id, type]));

        // If mapped row is a child, include its parent as top-level grouping node.
        const mappedChildParentIds = [...new Set(
            mappedTypes
                .map(type => type.parentPreferenceTypeId)
                .filter(parentId => parentId !== null && parentId !== undefined)
        )];
        if (mappedChildParentIds.length > 0) {
            const parentRows = await preferenceTypes.findAll({
                where: {
                    id: { [Op.in]: mappedChildParentIds },
                    status: true
                },
                attributes: ['id', 'name', 'parentPreferenceTypeId'],
                include: [
                    {
                        model: preferenceValues,
                        attributes: ['id', 'value'],
                        where: { status: true },
                        required: false
                    }
                ]
            });

            parentRows.forEach(parentRow => {
                const parent = parentRow.toJSON();
                if (!typeMap.has(parent.id)) {
                    typeMap.set(parent.id, parent);
                }
            });
        }

        const allTypes = Array.from(typeMap.values());

        // Parents are types without parentPreferenceTypeId.
        const parentTypes = allTypes.filter(type => !type.parentPreferenceTypeId);
        const parentIds = parentTypes.map(parent => parent.id);

        // Load all active children for the selected parents.
        let childTypes = [];
        if (parentIds.length > 0) {
            const childRows = await preferenceTypes.findAll({
                where: {
                    parentPreferenceTypeId: { [Op.in]: parentIds },
                    status: true
                },
                attributes: ['id', 'name', 'parentPreferenceTypeId'],
                include: [
                    {
                        model: preferenceValues,
                        attributes: ['id', 'value'],
                        where: { status: true },
                        required: false
                    }
                ]
            });
            childTypes = childRows.map(childRow => childRow.toJSON());
        }

        // Attach children to their parent.
        const nestedPreferences = parentTypes.map(parent => ({
            ...parent,
            childTypes: childTypes.filter(child => child.parentPreferenceTypeId === parent.id)
        }));

        const serviceCategoriesData =
            await this.getServiceCategoriesDataForService(serviceId);

        const serviceRow = await service.findByPk(serviceId, {
            attributes: [
                'id',
                'name',
                'washBleedDisclaimerEnabled',
                'numberOfBags',
                'numberOfItems',
            ],
        });

        if (!serviceRow) {
            throw new NotFoundError('Service Not Found');
        }

        return {
            preferencesData: nestedPreferences,
            serviceCategoriesData: serviceCategoriesData,
            washBleedDisclaimerEnabled: Boolean(serviceRow.washBleedDisclaimerEnabled),
            numberOfBags: Boolean(serviceRow.numberOfBags),
            numberOfItems: Boolean(serviceRow.numberOfItems),
        };
    }


    /** 
     * @params {serviceId} Delete Services
     * @returns {Object} Deleted service data
     */

    async deleteService(serviceId) {
        
            const deleteService = await service.destroy({ where: { id: serviceId } });
            if (!deleteService) {
                throw new NotFoundError('Service Not Found')
            }
            return deleteService;
    }

    /**
     * Edit Services
     * @param {number} serviceId - Service ID
     * @param {string} name - Service name
     * @param {string} description - Service description
     * @returns {Object} Edited service data
     */
    async editService(serviceId, serviceData) {
        const payload = pickServiceWritableFields(serviceData);
        const [affected] = await service.update(payload, { where: { id: serviceId } });
        if (!affected) {
            throw new NotFoundError('Service Not Found');
        }
        const updated = await service.findByPk(serviceId);
        if (!updated) {
            throw new NotFoundError('Service Not Found');
        }
        return updated;
    }

    /**
     * Update sort order for multiple services at once
     * @param {Array} services - Array of { serviceId, sortOrder }
     * @returns {Object} Update result
     */
    async updateServicesSortOrder(services) {
        if (!Array.isArray(services) || services.length === 0) {
            throw new ValidationError('Provide an array of { serviceId, sortOrder }');
        }

        await Promise.all(
            services.map(({ serviceId, sortOrder }) =>
                service.update({ sortOrder }, { where: { id: serviceId } })
            )
        );

        return { updated: services.length };
    }

    /**
     * Update sort order for multiple categories at once
     * @param {Array} items - Array of { categoryId, sortOrder }
     */
    async updateCategoriesSortOrder(items) {
        if (!Array.isArray(items) || items.length === 0) {
            throw new ValidationError('Provide an array of { categoryId, sortOrder }');
        }

        await Promise.all(
            items.map(({ categoryId, sortOrder }) =>
                categories.update(
                    { sortOrder: Number(sortOrder) },
                    { where: { id: categoryId } }
                )
            )
        );

        return { updated: items.length };
    }

    /**
     * Update sort order for multiple sub-categories at once
     * @param {Array} items - Array of { subCategoryId, sortOrder }
     */
    async updateSubCategoriesSortOrder(items) {
        if (!Array.isArray(items) || items.length === 0) {
            throw new ValidationError('Provide an array of { subCategoryId, sortOrder }');
        }

        await Promise.all(
            items.map(({ subCategoryId, sortOrder }) =>
                subCategories.update(
                    { sortOrder: Number(sortOrder) },
                    { where: { id: subCategoryId } }
                )
            )
        );

        return { updated: items.length };
    }

    /**
     * Assign services to categories
     * @param {number} serviceId - Service ID
     * @param {Array} categoryIds - Array of category IDs
     * @returns {Object} Assignment result
     */
    async assignServiceToCategories(serviceId, categoryIds) {
            if (!serviceId || !categoryIds || !Array.isArray(categoryIds) || categoryIds.length === 0) {
                throw new ValidationError('Invalid input. Please provide serviceId and an array of categoryIds.');
            }

            const existingAssignments = await serviceCategories.findAll({
                where: {
                    serviceId,
                    categoryId: { [sequelize.Op.in]: categoryIds },
                    status: true
                },
                attributes: ['categoryId']
            });

            const existingCategoryIds = existingAssignments.map(item => item.categoryId);
            const newCategoryIds = categoryIds.filter(id => !existingCategoryIds.includes(id));

            if (newCategoryIds.length === 0) {
                throw new ValidationError('All selected categories are already assigned to the service.');
            }

            const serviceCategoriesData = newCategoryIds.map(id => ({
                serviceId: serviceId,
                categoryId: id,
                status: true
            }));

            const createData = await serviceCategories.bulkCreate(serviceCategoriesData);

            await categories.update(
                { serviceId },
                { where: { id: { [Op.in]: newCategoryIds } } }
            );

            return createData;
    }

    /**
     * Unassign service from categories
     * @param {number} serviceId - Service ID
     * @param {Array} categoryIds - Optional array of category IDs to unassign (if not provided, unassigns all)
     * @returns {Object} Unassignment result
     */
    async unassignServiceFromCategories(serviceId, categoryIds = null) {
        if (!serviceId) {
            throw new ValidationError('Service ID is required');
        }

        const whereClause = { serviceId };
        
        // If specific categoryIds provided, unassign only those
        if (categoryIds && Array.isArray(categoryIds) && categoryIds.length > 0) {
            whereClause.categoryId = { [sequelize.Op.in]: categoryIds };
        }

        // Check if any assignments exist
        const existingAssignments = await serviceCategories.findAll({
            where: whereClause
        });

        if (!existingAssignments || existingAssignments.length === 0) {
            throw new NotFoundError('No service-category assignments found to unassign');
        }

        // Soft delete (since paranoid is enabled)
        const unassignedCount = await serviceCategories.destroy({
            where: whereClause
        });

        if (categoryIds && Array.isArray(categoryIds) && categoryIds.length > 0) {
            await categories.update(
                { serviceId: null },
                {
                    where: {
                        id: { [Op.in]: categoryIds },
                        serviceId: Number(serviceId),
                    },
                }
            );
        } else {
            const linkedCategoryIds = existingAssignments.map((row) => row.categoryId);
            if (linkedCategoryIds.length > 0) {
                await categories.update(
                    { serviceId: null },
                    {
                        where: {
                            id: { [Op.in]: linkedCategoryIds },
                            serviceId: Number(serviceId),
                        },
                    }
                );
            }
        }

        return {
            unassignedCount: unassignedCount,
            serviceId: serviceId,
            categoryIds: categoryIds || 'all'
        };
    }

    /**
     * Add subcategories with barcode generation
     * @param {Array} subCategoryData - Array of subcategory data
     * @param {Function} generateBarcodeFunction - Function to generate barcode
     * @returns {Array} Created subcategories
     */
    async addSubCategoriesWithBarcode(subCategoryData, generateBarcodeFunction) {
            const maxByCategory = new Map();
            for (const cat of subCategoryData) {
                const categoryId = Number(cat.categoryId);
                if (!categoryId || maxByCategory.has(categoryId)) continue;
                const maxSort = await subCategories.max('sortOrder', {
                    where: { categoryId },
                });
                maxByCategory.set(categoryId, Number(maxSort) || 0);
            }

            const processedData = subCategoryData.map((cat) => {
                const fileName = `barcode-${Date.now()}-${Math.floor(Math.random() * 10000)}.png`;
                const barcodePath = generateBarcodeFunction(cat.name, cat.price, fileName);
                const categoryId = Number(cat.categoryId);
                const nextSort = (maxByCategory.get(categoryId) || 0) + 1;
                if (categoryId) maxByCategory.set(categoryId, nextSort);

                // eslint-disable-next-line no-unused-vars
                const { addOnCategoryIds, excludedAddOnCategoryIds, ...rest } = cat;
                return {
                    ...rest,
                    status: true,
                    barCode: barcodePath,
                    sortOrder:
                        cat.sortOrder != null && !Number.isNaN(Number(cat.sortOrder))
                            ? Number(cat.sortOrder)
                            : nextSort,
                };
            });

            const createSubCategories = await subCategories.bulkCreate(processedData);

            if (!createSubCategories) {
                throw new Error('There is error in the request');
            }

            // Link each created sub-category to its selected add-on categories
            // and optional inheritance exclusions.
            await Promise.all(createSubCategories.map(async (row, idx) => {
                const ids = normalizeAddOnCategoryIds(subCategoryData[idx]?.addOnCategoryIds);
                if (ids.length) {
                    await row.setAddOnCategories(ids);
                }
                const excludedIds = normalizeAddOnCategoryIds(
                    subCategoryData[idx]?.excludedAddOnCategoryIds
                );
                if (excludedIds.length) {
                    await row.setExcludedAddOnCategories(excludedIds);
                }
            }));

            return createSubCategories;
    }

    /**
     * Get service categories assignments
     * @param {number} serviceId - Service ID
     * @returns {Array} Service categories assignments
     */
    async getServiceCategories(serviceId) {
            const serviceCategoriesData = await serviceCategories.findAll({
                where: { serviceId },
                include: [
                    {
                        model: categories,
                        attributes: ['id', 'name', 'description']
                    }
                ]
            });
            return serviceCategoriesData;
    }

    /**
     * Remove service from categories
     * @param {number} serviceId - Service ID
     * @param {Array} categoryIds - Array of category IDs to remove
     * @returns {Object} Removal result
     */
    async removeServiceFromCategories(serviceId, categoryIds) {
            const removedAssignments = await serviceCategories.destroy({
                where: {
                    serviceId,
                    categoryId: { [sequelize.Op.in]: categoryIds }
                }
            });
            return { message: 'Service removed from categories successfully', removedCount: removedAssignments };
    }


}

module.exports = new ServiceManagementService();
