'use strict';

const { banner, zone, service, categories, subCategories } = require('../../models');
const { Op } = require('sequelize');
const {
  ValidationError,
  NotFoundError
} = require('../../middlewares/universalErrorHandler');
const { tableExists } = require('../../utils/migrationHelpers');
const {
  parseFormBoolean,
  emptyToNull,
  normalizeZoneIds,
  zoneIdsApplyTo,
  isMissingTableError,
} = require('../../utils/bannerPayload');

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
      zoneIds: normalizeZoneIds(plain.zoneIds),
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

  async ensureBannersTable() {
    const sequelize = banner.sequelize;
    const qi = sequelize.getQueryInterface();
    if (await tableExists(qi, 'banners')) return;
    const migration = require('../../migrations/20260513100000-create-banners');
    await migration.up(qi, sequelize.constructor);
  }

  async withBannersTable(work) {
    try {
      return await work();
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      await this.ensureBannersTable();
      return work();
    }
  }

  normalizeZoneIds(zoneIds) {
    return normalizeZoneIds(zoneIds);
  }

  async validateZoneIds(zoneIds) {
    if (zoneIds === null || zoneIds === undefined || zoneIds.length === 0) return;
    const invalid = zoneIds.filter((id) => Number.isNaN(id));
    if (invalid.length) {
      throw new ValidationError('zoneIds must contain valid integers');
    }
    const uniqueIds = [...new Set(zoneIds)];
    const found = await zone.findAll({
      where: { id: { [Op.in]: uniqueIds }, status: true },
      attributes: ['id']
    });
    if (found.length !== uniqueIds.length) {
      const foundIds = new Set(found.map((row) => Number(row.id)));
      const missing = uniqueIds.filter((id) => !foundIds.has(Number(id)));
      throw new ValidationError(
        `One or more zoneIds are invalid or inactive: ${missing.join(', ')}`
      );
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
      zoneIds,
      startDate,
      endDate,
      displayOrder,
      showOnHome,
      isActive
    } = data;
    const targetId = emptyToNull(data.targetId);

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

    const created = await this.withBannersTable(() =>
      banner.create({
        title: String(title).trim().slice(0, 200),
        description: emptyToNull(description),
        bannerImage: emptyToNull(bannerImage),
        offerType,
        discountValue: dv,
        maxDiscountCap: cap,
        targetType,
        targetId: resolvedTargetId,
        zoneIds: normalizedZoneIds,
        startDate: startDate || null,
        endDate: endDate || null,
        displayOrder: displayOrder != null ? parseInt(displayOrder, 10) : 1,
        showOnHome: parseFormBoolean(showOnHome, true),
        isActive: parseFormBoolean(isActive, true)
      })
    );

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
      const parsed = parseFormBoolean(query.isActive);
      if (parsed !== undefined) where.isActive = parsed;
    }
    if (query.targetType) {
      if (!TARGET_TYPES.includes(query.targetType)) {
        throw new ValidationError('Invalid targetType filter');
      }
      where.targetType = query.targetType;
    }

    const { count, rows } = await this.withBannersTable(() =>
      banner.findAndCountAll({
        where,
        order: [
          ['displayOrder', 'ASC'],
          ['createdAt', 'DESC']
        ],
        limit,
        offset
      })
    );

    let filtered = rows;
    const zoneIdFilter = query.zoneId ? parseInt(query.zoneId, 10) : null;
    if (zoneIdFilter && !Number.isNaN(zoneIdFilter)) {
      filtered = rows.filter((row) => zoneIdsApplyTo(row.zoneIds, zoneIdFilter));
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
    const row = await this.withBannersTable(() => banner.findByPk(id));
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
    if (data.description !== undefined) row.description = emptyToNull(data.description);
    if (data.bannerImage !== undefined && data.bannerImage !== '') {
      row.bannerImage = emptyToNull(data.bannerImage);
    }

    const targetType = data.targetType !== undefined ? data.targetType : row.targetType;
    const targetId =
      data.targetId !== undefined ? emptyToNull(data.targetId) : row.targetId;

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
    if (data.showOnHome !== undefined) {
      row.showOnHome = parseFormBoolean(data.showOnHome, row.showOnHome);
    }
    if (data.isActive !== undefined) {
      row.isActive = parseFormBoolean(data.isActive, row.isActive);
    }

    await row.save();

    const target = await this.resolveTarget(row.targetType, row.targetId);
    const zones = await this.resolveZones(row.zoneIds);

    return {
      message: 'Banner updated successfully',
      data: this.formatBanner(row, { target, zones })
    };
  }

  async deleteBanner(id) {
    const row = await this.withBannersTable(() => banner.findByPk(id));
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
      const parsed = parseFormBoolean(query.showOnHome);
      if (parsed !== undefined) where.showOnHome = parsed;
    }

    let rows;
    try {
      rows = await this.withBannersTable(() =>
        banner.findAll({
          where,
          order: [['displayOrder', 'ASC']]
        })
      );
    } catch (err) {
      // Home must still render if the catalog table is missing on a drifted DB.
      console.error('getActiveBannersForCustomer:', err.message);
      return { message: 'Banners fetched successfully', data: { banners: [] } };
    }

    const zoneIdFilter = query.zoneId ? parseInt(query.zoneId, 10) : null;
    let filtered = rows;
    if (zoneIdFilter && !Number.isNaN(zoneIdFilter)) {
      filtered = rows.filter((row) => zoneIdsApplyTo(row.zoneIds, zoneIdFilter));
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

  async healthProbe() {
    try {
      const qi = banner.sequelize.getQueryInterface();
      const exists = await tableExists(qi, 'banners');
      if (!exists) {
        return {
          ok: false,
          table: 'banners',
          error: 'banners table missing'
        };
      }
      const count = await banner.count();
      return {
        ok: true,
        table: 'banners',
        count,
        customer: 'GET /customer/getBanners?zoneId=&showOnHome=true',
        adminCreate: 'POST /admin/createBanner (multipart image or bannerImage)',
        home: 'GET /customer/getHomeConfig includes data.banners'
      };
    } catch (err) {
      return {
        ok: false,
        table: 'banners',
        error: err.message || String(err)
      };
    }
  }
}

module.exports = new BannerService();
