/**
 * Example of proper error handling with HTTP status codes
 * This shows how to use the new error handling system in your controllers
 */

const { 
    ValidationException, 
    NotFoundException, 
    UnauthorizedException, 
    ConflictException 
} = require('../middlewares/customError');

const ResponseHelper = require('../utils/responseHelper');
const { asyncHandler } = require('../middlewares/httpErrorHandler');

/**
 * Example controller function with proper error handling
 */
const exampleController = {
    
    /**
     * Example: Get user by ID with proper error handling
     */
    getUserById: asyncHandler(async (req, res) => {
        const { userId } = req.params;
        
        // Validation
        if (!userId || isNaN(userId)) {
            throw new ValidationException('Invalid user ID provided');
        }
        
        // Simulate database query
        const user = await findUserById(userId);
        
        if (!user) {
            throw new NotFoundException('User not found');
        }
        
        // Success response
        return ResponseHelper.success(res, 'User retrieved successfully', user);
    }),
    
    /**
     * Example: Create user with validation
     */
    createUser: asyncHandler(async (req, res) => {
        const { email, name, age } = req.body;
        
        // Validation
        if (!email || !name) {
            throw new ValidationException('Email and name are required', {
                missing: {
                    email: !email,
                    name: !name
                }
            });
        }
        
        if (age && (age < 0 || age > 120)) {
            throw new ValidationException('Age must be between 0 and 120');
        }
        
        // Check if user already exists
        const existingUser = await findUserByEmail(email);
        if (existingUser) {
            throw new ConflictException('User with this email already exists');
        }
        
        // Create user
        const newUser = await createUser({ email, name, age });
        
        // Success response
        return ResponseHelper.created(res, 'User created successfully', newUser);
    }),
    
    /**
     * Example: Update user with proper error handling
     */
    updateUser: asyncHandler(async (req, res) => {
        const { userId } = req.params;
        const { name, age } = req.body;
        
        // Validation
        if (!userId || isNaN(userId)) {
            throw new ValidationException('Invalid user ID provided');
        }
        
        // Check if user exists
        const user = await findUserById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        
        // Update user
        const updatedUser = await updateUser(userId, { name, age });
        
        // Success response
        return ResponseHelper.success(res, 'User updated successfully', updatedUser);
    }),
    
    /**
     * Example: Delete user
     */
    deleteUser: asyncHandler(async (req, res) => {
        const { userId } = req.params;
        
        // Validation
        if (!userId || isNaN(userId)) {
            throw new ValidationException('Invalid user ID provided');
        }
        
        // Check if user exists
        const user = await findUserById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        
        // Delete user
        await deleteUser(userId);
        
        // Success response
        return ResponseHelper.success(res, 'User deleted successfully');
    }),
    
    /**
     * Example: Get users with pagination
     */
    getUsers: asyncHandler(async (req, res) => {
        const { page = 1, limit = 10, search } = req.query;
        
        // Validation
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        
        if (pageNum < 1 || limitNum < 1 || limitNum > 100) {
            throw new ValidationException('Invalid pagination parameters');
        }
        
        // Get users
        const { users, total, totalPages } = await getUsersWithPagination({
            page: pageNum,
            limit: limitNum,
            search
        });
        
        const pagination = {
            currentPage: pageNum,
            totalPages,
            totalRecords: total,
            recordsPerPage: limitNum,
            hasNextPage: pageNum < totalPages,
            hasPrevPage: pageNum > 1
        };
        
        // Success response with pagination
        return ResponseHelper.paginated(res, 'Users retrieved successfully', users, pagination);
    })
};

/**
 * Example service functions (simulated)
 */
async function findUserById(id) {
    // Simulate database query
    if (id === '999') return null;
    return { id, name: 'John Doe', email: 'john@example.com' };
}

async function findUserByEmail(email) {
    // Simulate database query
    if (email === 'existing@example.com') {
        return { id: 1, name: 'Existing User', email };
    }
    return null;
}

async function createUser(userData) {
    // Simulate user creation
    return { id: Math.floor(Math.random() * 1000), ...userData, createdAt: new Date() };
}

async function updateUser(id, updateData) {
    // Simulate user update
    return { id, ...updateData, updatedAt: new Date() };
}

async function deleteUser(id) {
    // Simulate user deletion
    return true;
}

async function getUsersWithPagination({ page, limit, search }) {
    // Simulate paginated query
    const users = [
        { id: 1, name: 'User 1', email: 'user1@example.com' },
        { id: 2, name: 'User 2', email: 'user2@example.com' }
    ];
    
    return {
        users,
        total: 2,
        totalPages: 1
    };
}

module.exports = exampleController;
