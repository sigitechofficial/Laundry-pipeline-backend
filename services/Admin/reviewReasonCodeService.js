'use strict';

const { reviewReasonCode } = require('../../models');
const { Op } = require('sequelize');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
} = require('../../middlewares/universalErrorHandler');

const CODE_REGEX = /^[A-Z][A-Z0-9_]{1,62}$/;

class ReviewReasonCodeService {
  async getAll({ activeOnly = false, sentiment } = {}) {
    const where = {};
    if (activeOnly) where.status = true;
    if (sentiment === 'positive' || sentiment === 'negative') {
      where.sentiment = sentiment;
    }
    return reviewReasonCode.findAll({
      where,
      order: [
        ['sentiment', 'ASC'],
        ['sortOrder', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });
  }

  async create(data) {
    const code = String(data.code || '')
      .trim()
      .toUpperCase();
    const label = String(data.label || '').trim();
    const sentiment = data.sentiment;

    if (!CODE_REGEX.test(code)) {
      throw new ValidationError(
        'Code must be uppercase letters/numbers/underscores (e.g. POS_QUALITY)'
      );
    }
    if (!label) {
      throw new ValidationError('Label is required');
    }
    if (sentiment !== 'positive' && sentiment !== 'negative') {
      throw new ValidationError('Sentiment must be positive or negative');
    }

    const duplicateCode = await reviewReasonCode.findOne({ where: { code } });
    if (duplicateCode) {
      throw new ConflictError('This reason code already exists');
    }

    const duplicateLabel = await reviewReasonCode.findOne({
      where: { label, sentiment },
    });
    if (duplicateLabel) {
      throw new ConflictError('This label already exists for this sentiment');
    }

    if (data.isOther === true) {
      const existingOther = await reviewReasonCode.findOne({
        where: { isOther: true, sentiment },
      });
      if (existingOther) {
        throw new ConflictError(
          `An "Other" reason already exists for ${sentiment}. Only one is allowed.`
        );
      }
    }

    const sortOrder =
      data.sortOrder != null && !Number.isNaN(Number(data.sortOrder))
        ? Number(data.sortOrder)
        : 0;

    return reviewReasonCode.create({
      code,
      label,
      sentiment,
      sortOrder,
      status: data.status !== undefined ? Boolean(data.status) : true,
      isOther: Boolean(data.isOther),
    });
  }

  async update(id, data) {
    const reasonId = Number(id);
    if (!reasonId || Number.isNaN(reasonId)) {
      throw new ValidationError('Valid reason ID is required');
    }

    const row = await reviewReasonCode.findByPk(reasonId);
    if (!row) {
      throw new NotFoundError('Review reason code not found');
    }

    const payload = {};

    // Code is immutable after create
    if (data.label !== undefined) {
      const label = String(data.label).trim();
      if (!label) {
        throw new ValidationError('Label cannot be empty');
      }
      const sentimentForDup = data.sentiment || row.sentiment;
      const duplicate = await reviewReasonCode.findOne({
        where: {
          label,
          sentiment: sentimentForDup,
          id: { [Op.ne]: reasonId },
        },
      });
      if (duplicate) {
        throw new ConflictError('This label already exists for this sentiment');
      }
      payload.label = label;
    }

    if (data.sentiment !== undefined) {
      if (data.sentiment !== 'positive' && data.sentiment !== 'negative') {
        throw new ValidationError('Sentiment must be positive or negative');
      }
      payload.sentiment = data.sentiment;
    }

    if (data.sortOrder !== undefined) {
      payload.sortOrder = Number(data.sortOrder);
      if (Number.isNaN(payload.sortOrder)) {
        throw new ValidationError('sortOrder must be a number');
      }
    }

    if (data.status !== undefined) {
      const nextStatus = Boolean(data.status);
      if (!nextStatus && row.status) {
        const sentiment = payload.sentiment || row.sentiment;
        const activeCount = await reviewReasonCode.count({
          where: {
            sentiment,
            status: true,
            id: { [Op.ne]: reasonId },
          },
        });
        if (activeCount < 1) {
          throw new ConflictError(
            `Cannot deactivate the last active ${sentiment} reason code`
          );
        }
      }
      payload.status = nextStatus;
    }

    if (data.isOther !== undefined) {
      const nextIsOther = Boolean(data.isOther);
      const sentiment = payload.sentiment || row.sentiment;
      if (nextIsOther && !row.isOther) {
        const existingOther = await reviewReasonCode.findOne({
          where: {
            isOther: true,
            sentiment,
            id: { [Op.ne]: reasonId },
          },
        });
        if (existingOther) {
          throw new ConflictError(
            `An "Other" reason already exists for ${sentiment}. Only one is allowed.`
          );
        }
      }
      payload.isOther = nextIsOther;
    }

    await row.update(payload);
    return row;
  }

  async delete(id) {
    const reasonId = Number(id);
    if (!reasonId || Number.isNaN(reasonId)) {
      throw new ValidationError('Valid reason ID is required');
    }

    const row = await reviewReasonCode.findByPk(reasonId);
    if (!row) {
      throw new NotFoundError('Review reason code not found');
    }

    const { shopReviewReason } = require('../../models');
    const used = await shopReviewReason.count({
      where: { reasonCodeId: reasonId },
    });
    if (used > 0) {
      // Soft-deactivate instead of hard delete when used
      if (row.status) {
        const activeCount = await reviewReasonCode.count({
          where: {
            sentiment: row.sentiment,
            status: true,
            id: { [Op.ne]: reasonId },
          },
        });
        if (activeCount < 1) {
          throw new ConflictError(
            `Cannot remove the last active ${row.sentiment} reason code`
          );
        }
        await row.update({ status: false });
        return {
          message:
            'Reason code is in use; deactivated instead of deleted',
          deactivated: true,
        };
      }
      throw new ConflictError(
        'Reason code is already inactive and cannot be deleted because it has been used'
      );
    }

    if (row.status) {
      const activeCount = await reviewReasonCode.count({
        where: {
          sentiment: row.sentiment,
          status: true,
          id: { [Op.ne]: reasonId },
        },
      });
      if (activeCount < 1) {
        throw new ConflictError(
          `Cannot delete the last active ${row.sentiment} reason code`
        );
      }
    }

    await row.destroy();
    return { message: 'Review reason code deleted successfully' };
  }
}

module.exports = new ReviewReasonCodeService();
