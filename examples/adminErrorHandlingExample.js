/**
 * Example of admin-specific error handling with proper HTTP status codes
 * This shows how to use the new admin error handling system in your admin controllers
 */

const { 
    AdminValidationError, 
    AdminNotFoundError, 
    AdminUnauthorizedError, 
    AdminConflictError 
} = require('../middlewares/adminErrorHandler');

const AdminResponseHelper = require('../utils/adminResponseHelper');
const { adminAsyncHandler } = require('../middlewares/adminErrorHandler');

/**
 * Example admin controller functions with proper error handling
 */
const adminControllerExample = {
    
    /**
     * Example: Get customer by ID with admin-specific error handling
     */
    getCustomerById: adminAsyncHandler(async (req, res) => {
        const { customerId } = req.params;
        
        // Admin-specific validation
        if (!customerId || isNaN(customerId)) {
            throw new AdminValidationError('Invalid customer ID provided');
        }
        
        // Simulate database query
        const customer = await findCustomerById(customerId);
        
        if (!customer) {
            throw new AdminNotFoundError('Customer not found');
        }
        
        // Admin success response
        return AdminResponseHelper.success(res, 'Customer retrieved successfully', customer);
    }),
    
    /**
     * Example: Create new service with admin validation
     */
    createService: adminAsyncHandler(async (req, res) => {
        const { name, description, categoryId } = req.body;
        
        // Admin-specific validation
        if (!name || name.trim().length === 0) {
            throw new AdminValidationError('Service name is required');
        }
        
        if (name.length < 2 || name.length > 100) {
            throw new AdminValidationError('Service name must be between 2 and 100 characters');
        }
        
        if (!categoryId || isNaN(categoryId)) {
            throw new AdminValidationError('Valid category ID is required');
        }
        
        // Check if service already exists
        const existingService = await findServiceByName(name.trim());
        if (existingService) {
            throw new AdminConflictError('Service with this name already exists');
        }
        
        // Check if category exists
        const category = await findCategoryById(categoryId);
        if (!category) {
            throw new AdminNotFoundError('Category not found');
        }
        
        // Create service
        const newService = await createService({
            name: name.trim(),
            description: description?.trim() || null,
            categoryId: parseInt(categoryId),
            status: true
        });
        
        // Admin success response
        return AdminResponseHelper.created(res, 'Service created successfully', newService);
    }),
    
    /**
     * Example: Update driver status with admin validation
     */
    updateDriverStatus: adminAsyncHandler(async (req, res) => {
        const { driverId } = req.params;
        const { status, reason } = req.body;
        
        // Admin-specific validation
        if (!driverId || isNaN(driverId)) {
            throw new AdminValidationError('Invalid driver ID provided');
        }
        
        if (typeof status !== 'boolean') {
            throw new AdminValidationError('Status must be a boolean value');
        }
        
        if (status === false && (!reason || reason.trim().length === 0)) {
            throw new AdminValidationError('Reason is required when deactivating driver');
        }
        
        // Check if driver exists
        const driver = await findDriverById(driverId);
        if (!driver) {
            throw new AdminNotFoundError('Driver not found');
        }
        
        // Check if driver has active orders
        if (status === false) {
            const activeOrders = await countActiveDriverOrders(driverId);
            if (activeOrders > 0) {
                throw new AdminConflictError(`Cannot deactivate driver with ${activeOrders} active orders`);
            }
        }
        
        // Update driver status
        const updatedDriver = await updateDriverStatus(driverId, status, reason);
        
        // Admin success response
        return AdminResponseHelper.success(res, 'Driver status updated successfully', updatedDriver);
    }),
    
    /**
     * Example: Get admin dashboard with proper error handling
     */
    getAdminDashboard: adminAsyncHandler(async (req, res) => {
        try {
            // Get dashboard data using service layer
            const dashboardData = await dashboardService.getDashboardData();
            
            // Admin dashboard response
            return AdminResponseHelper.dashboard(res, 'Dashboard data retrieved successfully', dashboardData);
        } catch (error) {
            // Re-throw as admin error
            throw new AdminValidationError('Failed to retrieve dashboard data');
        }
    }),
    
    /**
     * Example: Get orders with admin-specific filtering
     */
    getOrders: adminAsyncHandler(async (req, res) => {
        const { page = 1, limit = 20, status, date, customerId } = req.query;
        
        // Admin-specific validation
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        
        if (pageNum < 1 || limitNum < 1 || limitNum > 100) {
            throw new AdminValidationError('Invalid pagination parameters');
        }
        
        if (status && isNaN(status)) {
            throw new AdminValidationError('Invalid status parameter');
        }
        
        if (date && isNaN(Date.parse(date))) {
            throw new AdminValidationError('Invalid date format');
        }
        
        if (customerId && isNaN(customerId)) {
            throw new AdminValidationError('Invalid customer ID parameter');
        }
        
        // Get orders using service layer
        const filters = {};
        if (status) filters.status = status;
        if (date) filters.date = date;
        if (customerId) filters.customerId = customerId;
        
        const result = await orderService.getAllOrderDetails(filters, pageNum, limitNum);
        
        // Admin list response
        return AdminResponseHelper.list(res, 'Orders retrieved successfully', result.orderDetails, filters, result.pagination);
    }),
    
    /**
     * Example: Delete customer with admin validation
     */
    deleteCustomer: adminAsyncHandler(async (req, res) => {
        const { customerId } = req.params;
        const { reason } = req.body;
        
        // Admin-specific validation
        if (!customerId || isNaN(customerId)) {
            throw new AdminValidationError('Invalid customer ID provided');
        }
        
        if (!reason || reason.trim().length === 0) {
            throw new AdminValidationError('Deletion reason is required');
        }
        
        // Check if customer exists
        const customer = await findCustomerById(customerId);
        if (!customer) {
            throw new AdminNotFoundError('Customer not found');
        }
        
        // Check for active bookings
        const activeBookings = await countActiveCustomerBookings(customerId);
        if (activeBookings > 0) {
            throw new AdminConflictError(`Cannot delete customer with ${activeBookings} active booking(s)`);
        }
        
        // Soft delete customer
        await softDeleteCustomer(customerId, reason);
        
        // Admin success response
        return AdminResponseHelper.success(res, 'Customer deleted successfully', { 
            customerId, 
            deletedAt: new Date().toISOString(),
            reason 
        });
    }),
    
    /**
     * Example: Get admin statistics
     */
    getAdminStatistics: adminAsyncHandler(async (req, res) => {
        const { type, period } = req.query;
        
        // Admin-specific validation
        const validTypes = ['revenue', 'users', 'orders', 'drivers'];
        if (type && !validTypes.includes(type)) {
            throw new AdminValidationError('Invalid statistics type');
        }
        
        const validPeriods = ['daily', 'weekly', 'monthly', 'yearly'];
        if (period && !validPeriods.includes(period)) {
            throw new AdminValidationError('Invalid period parameter');
        }
        
        // Get statistics
        const statistics = await getAdminStatistics(type, period);
        
        // Admin statistics response
        return AdminResponseHelper.statistics(res, 'Statistics retrieved successfully', statistics);
    })
};

/**
 * Example service functions (simulated)
 */
async function findCustomerById(id) {
    // Simulate database query
    if (id === '999') return null;
    return { id, name: 'John Doe', email: 'john@example.com', userTypeId: 2 };
}

async function findServiceByName(name) {
    // Simulate database query
    if (name === 'Existing Service') {
        return { id: 1, name, status: true };
    }
    return null;
}

async function findCategoryById(id) {
    // Simulate database query
    if (id === '999') return null;
    return { id, name: 'Category Name', status: true };
}

async function createService(serviceData) {
    // Simulate service creation
    return { id: Math.floor(Math.random() * 1000), ...serviceData, createdAt: new Date() };
}

async function findDriverById(id) {
    // Simulate database query
    if (id === '999') return null;
    return { id, name: 'Driver Name', status: true, roleId: 6 };
}

async function countActiveDriverOrders(driverId) {
    // Simulate database query
    return Math.floor(Math.random() * 5);
}

async function updateDriverStatus(driverId, status, reason) {
    // Simulate driver update
    return { id: driverId, status, reason, updatedAt: new Date() };
}

async function countActiveCustomerBookings(customerId) {
    // Simulate database query
    return Math.floor(Math.random() * 3);
}

async function softDeleteCustomer(customerId, reason) {
    // Simulate soft delete
    return { id: customerId, status: false, deletedAt: new Date(), reason };
}

async function getAdminStatistics(type, period) {
    // Simulate statistics query
    return {
        type: type || 'all',
        period: period || 'monthly',
        data: {
            total: Math.floor(Math.random() * 1000),
            growth: Math.floor(Math.random() * 100)
        }
    };
}

module.exports = adminControllerExample;
