const { accountDeletionReason } = require('../../models');
const { Op } = require('sequelize');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
} = require('../../middlewares/universalErrorHandler');

class AccountDeletionReasonService {
  async getAll({ activeOnly = false } = {}) {
    const where = activeOnly ? { status: true } : {};
    return accountDeletionReason.findAll({
      where,
      order: [
        ['sortOrder', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });
  }

  async create(data) {
    const label = (data.label || '').trim();
    if (!label) {
      throw new ValidationError('Label is required');
    }

    const duplicate = await accountDeletionReason.findOne({ where: { label } });
    if (duplicate) {
      throw new ConflictError('This reason already exists');
    }

    if (data.isOther === true) {
      const existingOther = await accountDeletionReason.findOne({
        where: { isOther: true },
      });
      if (existingOther) {
        throw new ConflictError(
          'An "Other" reason already exists. Edit that row or remove it first.'
        );
      }
    }

    const sortOrder =
      data.sortOrder != null && !Number.isNaN(Number(data.sortOrder))
        ? Number(data.sortOrder)
        : 0;

    return accountDeletionReason.create({
      label,
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

    const row = await accountDeletionReason.findByPk(reasonId);
    if (!row) {
      throw new NotFoundError('Account deletion reason not found');
    }

    const payload = {};

    if (data.label !== undefined) {
      const label = String(data.label).trim();
      if (!label) {
        throw new ValidationError('Label cannot be empty');
      }
      const duplicate = await accountDeletionReason.findOne({
        where: {
          label,
          id: { [Op.ne]: reasonId },
        },
      });
      if (duplicate) {
        throw new ConflictError('This reason already exists');
      }
      payload.label = label;
    }

    if (data.sortOrder !== undefined) {
      payload.sortOrder = Number(data.sortOrder);
      if (Number.isNaN(payload.sortOrder)) {
        throw new ValidationError('sortOrder must be a number');
      }
    }

    if (data.status !== undefined) {
      payload.status = Boolean(data.status);
    }

    if (data.isOther !== undefined) {
      if (Boolean(data.isOther) && !row.isOther) {
        const existingOther = await accountDeletionReason.findOne({
          where: {
            isOther: true,
            id: { [Op.ne]: reasonId },
          },
        });
        if (existingOther) {
          throw new ConflictError(
            'An "Other" reason already exists. Only one is allowed.'
          );
        }
      }
      payload.isOther = Boolean(data.isOther);
    }

    await row.update(payload);
    return row;
  }

  async delete(id) {
    const reasonId = Number(id);
    if (!reasonId || Number.isNaN(reasonId)) {
      throw new ValidationError('Valid reason ID is required');
    }

    const row = await accountDeletionReason.findByPk(reasonId);
    if (!row) {
      throw new NotFoundError('Account deletion reason not found');
    }

    await row.destroy();
    return { message: 'Account deletion reason deleted successfully' };
  }
}

module.exports = new AccountDeletionReasonService();
