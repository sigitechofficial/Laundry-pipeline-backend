/**
 * Example of how to update your existing admin controller functions
 * to use proper HTTP status codes and error handling
 */

const { 
    ValidationException, 
    NotFoundException, 
    ConflictException 
} = require('../middlewares/customError');
const ResponseHelper = require('../utils/responseHelper');
const { asyncHandler } = require('../middlewares/httpErrorHandler');

/**
 * Example: Updated admin controller functions
 */
const adminControllerExample = {
    
    /**
     * Example: Get customer by ID with proper error handling
     */
    getCustomerById: asyncHandler(async (req, res) => {
        const { customerId } = req.params;
        
        // Validation
        if (!customerId || isNaN(customerId)) {
            throw new ValidationException('Invalid customer ID provided');
        }
        
        // Get customer using service layer
        const customer = await customerService.getSpecificCustomerDetails(customerId);
        
        return ResponseHelper.success(res, 'Customer details retrieved successfully', customer);
    }),
    
    /**
     * Example: Update customer with proper error handling
     */
    updateCustomer: asyncHandler(async (req, res) => {
        const { customerId } = req.params;
        const { firstName, lastName, email, phoneNum, status } = req.body;
        
        // Validation
        if (!customerId || isNaN(customerId)) {
            throw new ValidationException('Invalid customer ID provided');
        }
        
        if (!firstName && !lastName && !email && !phoneNum && status === undefined) {
            throw new ValidationException('At least one field must be provided for update');
        }
        
        // Check if customer exists
        const customerExists = await users.findOne({
            where: { id: customerId, userTypeId: 2 }
        });
        
        if (!customerExists) {
            throw new NotFoundException('Customer not found');
        }
        
        // Check email conflict
        if (email && email !== customerExists.email) {
            const emailExists = await users.findOne({
                where: { 
                    email: email, 
                    id: { [Op.ne]: customerId },
                    userTypeId: 2 
                }
            });
            
            if (emailExists) {
                throw new ConflictException('Email already exists');
            }
        }
        
        // Update customer
        const updateData = {};
        if (firstName) updateData.firstName = firstName;
        if (lastName) updateData.lastName = lastName;
        if (email) updateData.email = email;
        if (phoneNum) updateData.phoneNum = phoneNum;
        if (status !== undefined) updateData.status = status;
        
        const [updatedRows] = await users.update(updateData, {
            where: { id: customerId, userTypeId: 2 }
        });
        
        if (updatedRows === 0) {
            throw new ValidationException('No changes were made');
        }
        
        // Get updated customer
        const updatedCustomer = await users.findOne({
            where: { id: customerId, userTypeId: 2 },
            attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum', 'status', 'createdAt']
        });
        
        return ResponseHelper.success(res, 'Customer updated successfully', updatedCustomer);
    }),
    
    /**
     * Example: Delete customer with proper error handling
     */
    deleteCustomer: asyncHandler(async (req, res) => {
        const { customerId } = req.params;
        
        // Validation
        if (!customerId || isNaN(customerId)) {
            throw new ValidationException('Invalid customer ID provided');
        }
        
        // Check if customer exists
        const customerExists = await users.findOne({
            where: { id: customerId, userTypeId: 2 }
        });
        
        if (!customerExists) {
            throw new NotFoundException('Customer not found');
        }
        
        // Check for active bookings
        const activeBookings = await booking.count({
            where: {
                customerId: customerId,
                bookingStatusId: { [Op.notIn]: [17, 19, 23] } // Exclude completed, cancelled, failed
            }
        });
        
        if (activeBookings > 0) {
            throw new ConflictException(`Cannot delete customer with ${activeBookings} active booking(s)`);
        }
        
        // Soft delete
        await users.update(
            { status: false },
            { where: { id: customerId, userTypeId: 2 } }
        );
        
        return ResponseHelper.success(res, 'Customer deleted successfully', { customerId });
    }),
    
    /**
     * Example: Get orders with pagination and proper error handling
     */
    getOrders: asyncHandler(async (req, res) => {
        const { page = 1, limit = 20, status, date } = req.query;
        
        // Validation
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        
        if (pageNum < 1 || limitNum < 1 || limitNum > 100) {
            throw new ValidationException('Invalid pagination parameters');
        }
        
        if (status && isNaN(status)) {
            throw new ValidationException('Invalid status parameter');
        }
        
        if (date && isNaN(Date.parse(date))) {
            throw new ValidationException('Invalid date format');
        }
        
        // Get orders using service layer
        const filters = {};
        if (status) filters.status = status;
        if (date) filters.date = date;
        
        const result = await orderService.getAllOrderDetails(filters, pageNum, limitNum);
        
        return ResponseHelper.paginated(res, 'Orders retrieved successfully', result.orderDetails, result.pagination);
    }),
    
    /**
     * Example: Create new service with validation
     */
    createService: asyncHandler(async (req, res) => {
        const { name, description } = req.body;
        
        // Validation
        if (!name || name.trim().length === 0) {
            throw new ValidationException('Service name is required');
        }
        
        if (name.length < 2 || name.length > 100) {
            throw new ValidationException('Service name must be between 2 and 100 characters');
        }
        
        // Check if service already exists
        const existingService = await service.findOne({
            where: { name: name.trim() }
        });
        
        if (existingService) {
            throw new ConflictException('Service with this name already exists');
        }
        
        // Create service
        const newService = await service.create({
            name: name.trim(),
            description: description?.trim() || null,
            status: true
        });
        
        return ResponseHelper.created(res, 'Service created successfully', newService);
    }),
    
    /**
     * Example: Update service status
     */
    updateServiceStatus: asyncHandler(async (req, res) => {
        const { serviceId } = req.params;
        const { status } = req.body;
        
        // Validation
        if (!serviceId || isNaN(serviceId)) {
            throw new ValidationException('Invalid service ID provided');
        }
        
        if (typeof status !== 'boolean') {
            throw new ValidationException('Status must be a boolean value');
        }
        
        // Check if service exists
        const serviceExists = await service.findByPk(serviceId);
        if (!serviceExists) {
            throw new NotFoundException('Service not found');
        }
        
        // Update status
        await service.update(
            { status },
            { where: { id: serviceId } }
        );
        
        return ResponseHelper.success(res, 'Service status updated successfully', { serviceId, status });
    })
};

module.exports = adminControllerExample;
