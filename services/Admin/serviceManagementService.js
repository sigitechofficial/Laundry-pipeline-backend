const {
    subCategories,
    categories,
    service,
    serviceCategories,
    preferenceTypes,
    preferenceValues,
    serviceWithPreferences } = require('../../models');
const sequelize = require('sequelize');

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
        try {
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
        } catch (error) {
            throw new Error(`Admin services with categories service error: ${error.message}`);
        }
    }


    /**
     * Edit Subcategories
     * @param {number} subCategoryId - Subcategory ID
     * @param {string} name - Subcategory name
     * @param {string} price - Subcategory price
     * @returns {Object} Edited subcategory data
     */
    async editSubcategories(subCategoryId, name, price) {
        const editSubcategory = await subCategories.update({ name, price }, { where: { id: subCategoryId } });
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
        try {
            const findData = await subCategories.findAll({
                where: {
                    categoryId: categoryId
                },
                attributes: ['id', 'name', 'price', 'status']
            });

            return {
                serviceTypesItems: findData
            };
        } catch (error) {
            throw new Error(`Subcategories service error: ${error.message}`);
        }
    }

    /**
     * Get all services and categories for order editing
     * @returns {Object} Services, categories, and service categories
     */
    async getServicesAndCategoriesForOrderEdit() {
        try {
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
        } catch (error) {
            throw new Error(`Services and categories for order edit service error: ${error.message}`);
        }
    }

    /**
     * Get all services
     * @returns {Array} List of all active services
     */
    async getAllServices() {
        try {
            const getServices = await service.findAll({
                where: {
                    status: true,
                }
            });
            return { services: getServices };
        } catch (error) {
            throw new Error(`All services service error: ${error.message}`);
        }
    }

    /**
     * Get all categories
     * @returns {Array} List of all categories
     */
    async getCategories() {
        try {
            const getCategories = await categories.findAll();
            return getCategories;
        } catch (error) {
            throw new Error(`Categories service error: ${error.message}`);
        }
    }

    /**
     * Edit Categories
     * @param {number} categoryId - Category ID
     * @param {string} name - Category name
     * @param {string} description - Category description
     * @returns {Object} Edited category data
     */
    async editCategories(categoryId, name, description) {
        const editCategory = await categories.update({ name, description }, { where: { id: categoryId } });
        if (!editCategory) {
            throw new NotFoundError('Category Not Found')
        }
        return editCategory;
    }

    /**
     * Get all subcategories
     * @returns {Array} List of all subcategories
     */
    async getSubcategories() {
        try {
            const getSubcategories = await subCategories.findAll();
            return getSubcategories;
        } catch (error) {
            throw new Error(`Subcategories service error: ${error.message}`);
        }
    }

    /**
     * Add a new service
     * @param {Object} serviceData - Service data containing name, description, and image
     * @returns {Object} Created service data
     */
    async addService(serviceData) {
        try {
            const { name, description, image } = serviceData;

            const serviceCreate = await service.create({
                name,
                description,
                image,
            });

            return serviceCreate;
        } catch (error) {
            throw new Error(`Add service error: ${error.message}`);
        }
    }


    /**
     * Add new Category
     * @param {Object} categoryData - Category data containing name, description, and image
     * @returns {Object} Created category data
     */

    async addCategory(categoryData) {
        try {
            const { name, description, image } = categoryData;
            const categoryCreate = await categories.create({ name, description, image });
            return categoryCreate;
        } catch (error) {
            throw new Error(`Add category error: ${error.message}`);
        }
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
                    attributes: ['name'],
                    include: [
                        {
                            model: preferenceValues,
                            attributes: ['value']
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
        
            const deleteService = await service.destroy({ where: { serviceId: serviceId } });
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
    async editService(serviceId, name, description, serviceImg) {
        const editService = await service.update({ 
            name, 
            description,
            image: serviceImg 
        }, 
            { where: { serviceId: serviceId } });
        if (!editService) {
            throw new NotFoundError('Service Not Found')
        }
        return editService;
    }


}

module.exports = new ServiceManagementService();
