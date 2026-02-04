const { Blog } = require('../../models');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');

const {
    ValidationError,
    NotFoundError,
    ConflictError
} = require('../../middlewares/universalErrorHandler');

class BlogService {
    /**
     * Create new Blog
     * @param {Object} blogData - Blog data containing title, description, image
     * @returns {Object} Created Blog data
     */
    async createBlog(blogData) {
        const { title, description, image, descriptionImages } = blogData;

        // Validate required fields
        if (!title || !title.trim()) {
            throw new ValidationError("Title is required");
        }

        if (!description || !description.trim()) {
            throw new ValidationError("Description is required");
        }

        // Check if blog with same title already exists
        const existingBlog = await Blog.findOne({
            where: {
                title: title.trim()
            }
        });

        if (existingBlog) {
            throw new ConflictError("Blog with this title already exists");
        }

        // Process descriptionImages - ensure it's an array
        let descriptionImagesArray = [];
        if (descriptionImages) {
            if (Array.isArray(descriptionImages)) {
                descriptionImagesArray = descriptionImages;
            } else {
                descriptionImagesArray = [descriptionImages];
            }
        }

        // Create new Blog
        const newBlog = await Blog.create({
            title: title.trim(),
            description: description.trim(),
            image: image || null,
            descriptionImages: descriptionImagesArray,
            status: true
        });

        return newBlog;
    }

    /**
     * Get all Blogs
     * @param {Object} filters - Optional filters (status)
     * @returns {Array} List of all Blogs
     */
    async getAllBlogs(filters = {}) {
        const whereClause = {};

        // Filter by status if provided
        if (filters.status !== undefined) {
            whereClause.status = filters.status;
        }

        const blogs = await Blog.findAll({
            where: whereClause,
            order: [['createdAt', 'DESC']]
        });

        return blogs;
    }

    /**
     * Get Blog by ID
     * @param {number} blogId - Blog ID
     * @returns {Object} Blog data
     */
    async getBlogById(blogId) {
        if (!blogId) {
            throw new ValidationError("Blog ID is required");
        }

        const blog = await Blog.findByPk(blogId);

        if (!blog) {
            throw new NotFoundError("Blog not found");
        }

        return blog;
    }

    /**
     * Update an existing Blog
     * @param {number} blogId - Blog ID
     * @param {Object} blogData - Updated Blog data
     * @returns {Object} Updated Blog data
     */
    async updateBlog(blogId, blogData) {
        const { title, description, image, descriptionImages, status } = blogData;

        if (!blogId) {
            throw new ValidationError("Blog ID is required");
        }

        const existingBlog = await Blog.findByPk(blogId);

        if (!existingBlog) {
            throw new NotFoundError("Blog not found");
        }

        // Check if another blog with the same title exists
        if (title) {
            const duplicateBlog = await Blog.findOne({
                where: {
                    title: title.trim(),
                    id: {
                        [Op.ne]: blogId
                    }
                }
            });

            if (duplicateBlog) {
                throw new ConflictError("Blog with this title already exists");
            }
        }

        // If new image is provided and old image exists, delete old image
        if (image && existingBlog.image && image !== existingBlog.image) {
            const oldImagePath = path.join(__dirname, '../../', existingBlog.image);
            if (fs.existsSync(oldImagePath)) {
                fs.unlinkSync(oldImagePath);
            }
        }

        // Handle descriptionImages update
        let descriptionImagesArray = existingBlog.descriptionImages || [];
        if (descriptionImages !== undefined) {
            // Delete old description images if new ones are provided
            if (existingBlog.descriptionImages && existingBlog.descriptionImages.length > 0) {
                existingBlog.descriptionImages.forEach(oldImage => {
                    const oldImagePath = path.join(__dirname, '../../', oldImage);
                    if (fs.existsSync(oldImagePath)) {
                        fs.unlinkSync(oldImagePath);
                    }
                });
            }
            
            // Process new descriptionImages
            if (Array.isArray(descriptionImages)) {
                descriptionImagesArray = descriptionImages;
            } else if (descriptionImages) {
                descriptionImagesArray = [descriptionImages];
            } else {
                descriptionImagesArray = [];
            }
        }

        // Update Blog
        const updatedBlog = await existingBlog.update({
            title: title ? title.trim() : existingBlog.title,
            description: description ? description.trim() : existingBlog.description,
            image: image !== undefined ? image : existingBlog.image,
            descriptionImages: descriptionImagesArray,
            status: status !== undefined ? status : existingBlog.status
        });

        return updatedBlog;
    }

    /**
     * Delete a Blog (soft delete)
     * @param {number} blogId - Blog ID
     * @returns {Object} Deletion result
     */
    async deleteBlog(blogId) {
        if (!blogId) {
            throw new ValidationError("Blog ID is required");
        }

        const existingBlog = await Blog.findByPk(blogId);

        if (!existingBlog) {
            throw new NotFoundError("Blog not found");
        }

        // Delete associated image if exists
        if (existingBlog.image) {
            const imagePath = path.join(__dirname, '../../', existingBlog.image);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }

        // Delete description images if they exist
        if (existingBlog.descriptionImages && Array.isArray(existingBlog.descriptionImages)) {
            existingBlog.descriptionImages.forEach(imagePath => {
                const fullImagePath = path.join(__dirname, '../../', imagePath);
                if (fs.existsSync(fullImagePath)) {
                    fs.unlinkSync(fullImagePath);
                }
            });
        }

        // Soft delete (paranoid mode)
        await existingBlog.destroy();

        return { message: "Blog deleted successfully" };
    }

    /**
     * Toggle Blog status
     * @param {number} blogId - Blog ID
     * @returns {Object} Updated Blog
     */
    async toggleBlogStatus(blogId) {
        if (!blogId) {
            throw new ValidationError("Blog ID is required");
        }

        const existingBlog = await Blog.findByPk(blogId);

        if (!existingBlog) {
            throw new NotFoundError("Blog not found");
        }

        const updatedBlog = await existingBlog.update({
            status: !existingBlog.status
        });

        return updatedBlog;
    }
}

module.exports = new BlogService();

