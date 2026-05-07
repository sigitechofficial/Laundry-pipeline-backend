const {
    subCategories,
    categories,
    service,
    serviceCategories,
    preferenceTypes,
    preferenceValues,
    serviceWithPreferences,
    customerSelectedService } = require('../../models');
const sequelize = require('sequelize');
const { literal, fn, col, Op } = require("sequelize");

const {
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');

class ServiceManagementService {
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
        const editSubcategory = await subCategories.update(subCategoryData, { where: { id: subCategoryId } });
        if (!editSubcategory) {
            throw new NotFoundError('Subcategory Not Found')
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
                attributes: ['id', 'name', 'price', 'status']
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
    async getCategories() {
            const getCategories = await categories.findAll();
            return getCategories;
    }

    /**
     * Edit Categories
     * @param {number} categoryId - Category ID
     * @param {string} name - Category name
     * @param {string} description - Category description
     * @returns {Object} Edited category data
     */
    async editCategories(categoryId, categoryData) {
        const editCategory = await categories.update(categoryData, { where: { id: categoryId } });
        if (!editCategory) {
            throw new NotFoundError('Category Not Found')
        }
        return editCategory;
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
            const getSubcategories = await subCategories.findAll();
            return getSubcategories;
    }

    /**
     * Delete SubCategories
     * @param {number} subCategoryId - Subcategory ID
     * @returns {Object} Deleted subcategory data
     */
    async deleteSubcategories(subCategoryId) {
        const deleteSubcategory = await subCategories.destroy({ where: { id: subCategoryId } });
        if (!deleteSubcategory) {
    if (!deleteSubcategory) {
            throw new NotFoundError('Subcategory Not Found')
        }
        return deleteSubcategory;
    }
}

    /**
     * Add a new service
     * @param {Object} serviceData - Service data containing name, description, and image
     * @returns {Object} Created service data
     */
    async addService(serviceData) {
            const serviceCreate = await service.create(serviceData);
            return serviceCreate;
    }


    /**
     * Add new Category
     * @param {Object} categoryData - Category data containing name, description, and image
     * @returns {Object} Created category data
     */

    async addCategory(categoryData) {
            const categoryCreate = await categories.create(categoryData);
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

        const serviceCategoriesData = await serviceCategories.findAll({
            where: { serviceId: serviceId },
            include: [
                {
                    model: categories,
                    where: { status: true },
                    attributes: ['name', 'description'],
                    include: [
                        {
                            model: subCategories,
                            attributes: ['name', 'price', 'status', 'description']
                        }
                    ]
                }
            ]
        });

        if (!serviceCategoriesData) {
            throw new NotFoundError('Service Categories Data Not Found')
        }

        return {
            preferencesData: nestedPreferences,
            serviceCategoriesData: serviceCategoriesData
        }
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
        const editService = await service.update(serviceData, { where: { id: serviceId } });
        if (!editService) {
            throw new NotFoundError('Service Not Found')
        }
        return editService;
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
            const processedData = subCategoryData.map((cat) => {
                const fileName = `barcode-${Date.now()}-${Math.floor(Math.random() * 10000)}.png`;
                const barcodePath = generateBarcodeFunction(cat.name, cat.price, fileName);

                return {
                    ...cat,
                    status: true,
                    barCode: barcodePath
                };
            });

            const createSubCategories = await subCategories.bulkCreate(processedData);

            if (!createSubCategories) {
                throw new Error('There is error in the request');
            }

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
