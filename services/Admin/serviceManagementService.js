const {
    subCategories,
    categories,
    service,
    serviceCategories,
    preferenceTypes,
    preferenceValues,
    serviceWithPreferences } = require('../../models');
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
     * Get all services
     * @returns {Array} List of all active services
     */
    async getAllServices() {
            const getServices = await service.findAll({
                where: {
                    status: true,
                }
            });
            return { services: getServices };
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
        console.log("Service Id ====>",serviceId)
        const preferencesData = await serviceWithPreferences.findAll({
            where: {
                serviceId: serviceId
            },
            include: [
                {
                    model: preferenceTypes,
                    attributes: ['id','name'],
                    include: [
                        {
                            model: preferenceValues,
                            attributes: ['id','value']
                        },
                    ]
                }
            ],
            logging: console.log 
        })

        console.log("preferencesData======================>>>>>>",preferencesData)

        if (!preferencesData) {
            throw new NotFoundError('Preference Data Not Found')
        }

        const serviceCategoriesData = await serviceCategories.findAll({
            where: {
                serviceId: serviceId
            },
            include: [
                {
                    model: categories,
                    where: {
                        status: true
                    },
                    attributes: ['name', 'description'],
                    include: [
                        {
                            model: subCategories,
                            attributes: ['name', 'price', 'status', 'description']
                        }
                    ]
                }
            ]
        })

        if (!serviceCategoriesData) {
            throw new NotFoundError('Service Categories Data Not Found')
        }

        let outObj = {
            preferencesData: preferencesData,
            serviceCategoriesData: serviceCategoriesData
        }

        return outObj
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
