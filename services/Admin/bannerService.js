'use strict';

const { banner, zone, service, categories, subCategories } = require('../../models');
const { Op } = require('sequelize');
const {
  ValidationError,
  NotFoundError
} = require('../../middlewares/universalErrorHandler');

const OFFER_TYPES = ['percentage', 'flat', 'free_delivery'];
const TARGET_TYPES = ['global', 'service', 'category', 'sub_category'];

class BannerService {
  formatBanner(row, extras = {}) {
    const plain = row.toJSON ? row.toJSON() : { ...row };
    return {
      id: plain.id,
      title: plain.title,
      description: plain.description,
      bannerImage: plain.bannerImage,
      offerType: plain.offerType,
      discountValue: plain.discountValue != null ? parseFloat(plain.discountValue) : null,
      maxDiscountCap: plain.maxDiscountCap != null ? parseFloat(plain.maxDiscountCap) : null,
      targetType: plain.targetType,
      targetId: plain.targetId,
      zoneIds: Array.isArray(plain.zoneIds) ? plain.zoneIds : plain.zoneIds ? plain.zoneIds : null,
      startDate: plain.startDate,
      endDate: plain.endDate,
      displayOrder: plain.displayOrder,
      showOnHome: plain.showOnHome,
      isActive: plain.isActive,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
      ...extras
    };
  }

  normalizeZoneIds(zoneIds) {
    if (zoneIds === undefined || zoneIds === null || zoneIds === '') return null;

    // form-data sends comma-separated string e.g. "1,3" or single "1"
    if (typeof zoneIds === 'string') {
      const parts = zoneIds.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) return null;
      return parts.map((id) => parseInt(id, 10));
    }

    // multer with repeated keys sends array of strings e.g. ["1", "3"]
    if (Array.isArray(zoneIds)) {
      if (zoneIds.length === 0) return null;
      return zoneIds.map((id) => parseInt(id, 10));
    }

    // single number
    const parsed = parseInt(zoneIds, 10);
    if (Number.isNaN(parsed)) {
      throw new ValidationError('zoneIds must be valid integers');
    }
    return [parsed];
  }

  async validateZoneIds(zoneIds) {
    if (zoneIds === null || zoneIds === undefined || zoneIds.length === 0) return;
    const invalid = zoneIds.filter((id) => Number.isNaN(id));
    if (invalid.length) {
      throw new ValidationError('zoneIds must contain valid integers');
    }
    const found = await zone.findAll({
      where: { id: { [Op.in]: zoneIds }, status: true },
      attributes: ['id']
    });
    if (found.length !== zoneIds.length) {
      throw new ValidationError('One or more zoneIds are invalid or inactive');
    }
  }

  async validateTarget(targetType, targetId) {
    if (targetType === 'global') {
      if (targetId != null && targetId !== '') {
        throw new ValidationError('targetId must not be set when targetType is global');
      }
      return null;
    }

    if (targetId == null || targetId === '') {
      throw new ValidationError(`targetId is required when targetType is ${targetType}`);
    }

    const id = parseInt(targetId, 10);
    if (Number.isNaN(id)) {
      throw new ValidationError('targetId must be a valid integer');
    }

    let record = null;
    if (targetType === 'service') {
      record = await service.findByPk(id);
    } else if (targetType === 'category') {
      record = await categories.findByPk(id);
    } else if (targetType === 'sub_category') {
      record = await subCategories.findByPk(id);
    }

    if (!record) {
      throw new ValidationError(`No ${targetType.replace('_', ' ')} found with id ${id}`);
    }

    return id;
  }

  validateOfferAndDiscount(offerType, discountValue, maxDiscountCap) {
    if (!OFFER_TYPES.includes(offerType)) {
      throw new ValidationError('offerType must be percentage, flat, or free_delivery');
    }

    if (offerType === 'free_delivery') {
      if (discountValue != null && discountValue !== '') {
        throw new ValidationError('discountValue must not be set for free_delivery offers');
      }
      if (maxDiscountCap != null && maxDiscountCap !== '') {
        throw new ValidationError('maxDiscountCap is only valid for percentage offers');
      }
      return { discountValue: null, maxDiscountCap: null };
    }

    if (discountValue == null || discountValue === '') {
      throw new ValidationError('discountValue is required unless offerType is free_delivery');
    }

    const dv = parseFloat(discountValue);
    if (Number.isNaN(dv) || dv <= 0) {
      throw new ValidationError('discountValue must be greater than 0');
    }

    if (offerType === 'percentage' && dv > 100) {
      throw new ValidationError('Percentage discount cannot exceed 100');
    }

    let cap = null;
    if (maxDiscountCap != null && maxDiscountCap !== '') {
      if (offerType !== 'percentage') {
        throw new ValidationError('maxDiscountCap is only valid for percentage offers');
      }
      cap = parseFloat(maxDiscountCap);
      if (Number.isNaN(cap) || cap <= 0) {
        throw new ValidationError('maxDiscountCap must be greater than 0');
      }
    }

    return { discountValue: dv, maxDiscountCap: cap };
  }

  validateDates(startDate, endDate) {
    if (startDate && endDate && endDate < startDate) {
      throw new ValidationError('endDate must be greater than or equal to startDate');
    }
  }

  async resolveTarget(targetType, targetId) {
    if (targetType === 'global' || !targetId) return null;

    if (targetType === 'service') {
      const row = await service.findByPk(targetId, { attributes: ['id', 'name'] });
      return row ? { id: row.id, name: row.name } : null;
    }
    if (targetType === 'category') {
      const row = await categories.findByPk(targetId, { attributes: ['id', 'name'] });
      return row ? { id: row.id, name: row.name } : null;
    }
    if (targetType === 'sub_category') {
      const row = await subCategories.findByPk(targetId, { attributes: ['id', 'name'] });
      return row ? { id: row.id, name: row.name } : null;
    }
    return null;
  }

  async resolveZones(zoneIds) {
    if (!zoneIds || !Array.isArray(zoneIds) || zoneIds.length === 0) return [];
    const rows = await zone.findAll({
      where: { id: { [Op.in]: zoneIds } },
      attributes: ['id', 'name']
    });
    return rows.map((z) => ({ id: z.id, name: z.name }));
  }

  async createBanner(data) {
    const {
      title,
      description,
      bannerImage,
      offerType,
      discountValue,
      maxDiscountCap,
      targetType,
      targetId,
      zoneIds,
      startDate,
      endDate,
      displayOrder,
      showOnHome,
      isActive
    } = data;

    if (!title || !String(title).trim()) {
      throw new ValidationError('title is required');
    }
    if (!offerType) {
      throw new ValidationError('offerType is required');
    }
    if (!targetType) {
      throw new ValidationError('targetType is required');
    }
    if (!TARGET_TYPES.includes(targetType)) {
      throw new ValidationError('targetType must be global, service, category, or sub_category');
    }

    const { discountValue: dv, maxDiscountCap: cap } = this.validateOfferAndDiscount(
      offerType,
      discountValue,
      maxDiscountCap
    );
    const resolvedTargetId = await this.validateTarget(targetType, targetId);
    const normalizedZoneIds = this.normalizeZoneIds(zoneIds);
    await this.validateZoneIds(normalizedZoneIds);
    this.validateDates(startDate || null, endDate || null);

    const created = await banner.create({
      title: String(title).trim().slice(0, 200),
      description: description || null,
      bannerImage: bannerImage || null,
      offerType,
      discountValue: dv,
      maxDiscountCap: cap,
      targetType,
      targetId: resolvedTargetId,
      zoneIds: normalizedZoneIds,
      startDate: startDate || null,
      endDate: endDate || null,
      displayOrder: displayOrder != null ? parseInt(displayOrder, 10) : 1,
      showOnHome: showOnHome !== undefined ? Boolean(showOnHome) : true,
      isActive: isActive !== undefined ? Boolean(isActive) : true
    });

    return {
      message: 'Banner created successfully',
      data: this.formatBanner(created)
    };
  }

  async getAllBanners(query = {}) {
    const page = parseInt(query.page, 10) || 1;
    const limit = parseInt(query.limit, 10) || 10;
    const offset = (page - 1) * limit;
    const where = {};

    if (query.isActive !== undefined) {
      where.isActive = query.isActive === 'true' || query.isActive === true;
    }
    if (query.targetType) {
      if (!TARGET_TYPES.includes(query.targetType)) {
        throw new ValidationError('Invalid targetType filter');
      }
      where.targetType = query.targetType;
    }

    const { count, rows } = await banner.findAndCountAll({
      where,
      order: [
        ['displayOrder', 'ASC'],
        ['createdAt', 'DESC']
      ],
      limit,
      offset
    });

    let filtered = rows;
    const zoneIdFilter = query.zoneId ? parseInt(query.zoneId, 10) : null;
    if (zoneIdFilter && !Number.isNaN(zoneIdFilter)) {
      filtered = rows.filter((row) => {
        const ids = row.zoneIds;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return true;
        return ids.includes(zoneIdFilter);
      });
    }

    const banners = await Promise.all(
      filtered.map(async (row) => {
        const target = await this.resolveTarget(row.targetType, row.targetId);
        const zones = await this.resolveZones(row.zoneIds);
        return this.formatBanner(row, { target, zones });
      })
    );

    return {
      message: 'Banners fetched successfully',
      data: { banners },
      meta: {
        pagination: {
          total: zoneIdFilter ? banners.length : count,
          page,
          limit,
          totalPages: Math.ceil((zoneIdFilter ? banners.length : count) / limit) || 1
        }
      }
    };
  }

  async updateBanner(id, data) {
    const row = await banner.findByPk(id);
    if (!row) {
      throw new NotFoundError(`Banner with id ${id} not found`);
    }

    const offerType = data.offerType !== undefined ? data.offerType : row.offerType;
    const discountValue =
      data.discountValue !== undefined ? data.discountValue : row.discountValue;
    const maxDiscountCap =
      data.maxDiscountCap !== undefined ? data.maxDiscountCap : row.maxDiscountCap;

    if (
      data.offerType !== undefined ||
      data.discountValue !== undefined ||
      data.maxDiscountCap !== undefined
    ) {
      const validated = this.validateOfferAndDiscount(offerType, discountValue, maxDiscountCap);
      row.offerType = offerType;
      row.discountValue = validated.discountValue;
      row.maxDiscountCap = validated.maxDiscountCap;
    }

    if (data.title !== undefined) {
      if (!String(data.title).trim()) throw new ValidationError('title cannot be empty');
      row.title = String(data.title).trim().slice(0, 200);
    }
    if (data.description !== undefined) row.description = data.description;
    if (data.bannerImage !== undefined) row.bannerImage = data.bannerImage;

    const targetType = data.targetType !== undefined ? data.targetType : row.targetType;
    const targetId = data.targetId !== undefined ? data.targetId : row.targetId;

    if (data.targetType !== undefined || data.targetId !== undefined) {
      if (!TARGET_TYPES.includes(targetType)) {
        throw new ValidationError('targetType must be global, service, category, or sub_category');
      }
      row.targetType = targetType;
      row.targetId = await this.validateTarget(targetType, targetId);
    }

    if (data.zoneIds !== undefined) {
      const normalizedZoneIds = this.normalizeZoneIds(data.zoneIds);
      await this.validateZoneIds(normalizedZoneIds);
      row.zoneIds = normalizedZoneIds;
    }

    const startDate = data.startDate !== undefined ? data.startDate : row.startDate;
    const endDate = data.endDate !== undefined ? data.endDate : row.endDate;
    if (data.startDate !== undefined) row.startDate = data.startDate || null;
    if (data.endDate !== undefined) row.endDate = data.endDate || null;
    this.validateDates(startDate, endDate);

    if (data.displayOrder !== undefined) row.displayOrder = parseInt(data.displayOrder, 10);
    if (data.showOnHome !== undefined) row.showOnHome = Boolean(data.showOnHome);
    if (data.isActive !== undefined) row.isActive = Boolean(data.isActive);

    await row.save();

    const target = await this.resolveTarget(row.targetType, row.targetId);
    const zones = await this.resolveZones(row.zoneIds);

    return {
      message: 'Banner updated successfully',
      data: this.formatBanner(row, { target, zones })
    };
  }

  async deleteBanner(id) {
    const row = await banner.findByPk(id);
    if (!row) {
      throw new NotFoundError(`Banner with id ${id} not found`);
    }
    await row.destroy();
    return {
      message: 'Banner deleted successfully',
      data: null
    };
  }

  /**
   * Customer-facing: get active banners for today, filtered by zone if provided.
   * @param {Object} query - { zoneId, showOnHome }
   */
  async getActiveBannersForCustomer(query = {}) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const where = {
      isActive: true,
      [Op.and]: [
        { [Op.or]: [{ startDate: null }, { startDate: { [Op.lte]: today } }] },
        { [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: today } }] }
      ]
    };

    // Optional: only home slider banners
    if (query.showOnHome !== undefined) {
      where.showOnHome = query.showOnHome === 'true' || query.showOnHome === true;
    }

    const rows = await banner.findAll({
      where,
      order: [['displayOrder', 'ASC']]
    });

    // Filter by zoneId if provided
    const zoneIdFilter = query.zoneId ? parseInt(query.zoneId, 10) : null;
    let filtered = rows;
    if (zoneIdFilter && !Number.isNaN(zoneIdFilter)) {
      filtered = rows.filter((row) => {
        const ids = row.zoneIds;
        // null or empty = applies to all zones
        if (!ids || !Array.isArray(ids) || ids.length === 0) return true;
        return ids.includes(zoneIdFilter);
      });
    }

    const banners = await Promise.all(
      filtered.map(async (row) => {
        const target = await this.resolveTarget(row.targetType, row.targetId);
        return this.formatBanner(row, { target });
      })
    );

    return {
      message: 'Banners fetched successfully',
      data: { banners }
    };
  }
}

module.exports = new BannerService();
