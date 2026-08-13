'use strict';

const {
  repairGarment,
  repairOption,
  repairGarmentOption,
  service,
} = require('../../models');
const { Op } = require('sequelize');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
} = require('../../middlewares/universalErrorHandler');

const OPTION_INCLUDE = {
  model: repairOption,
  as: 'options',
  attributes: ['id', 'name', 'description', 'price', 'status', 'sortOrder'],
  through: { attributes: [] },
};

class RepairCatalogService {
  async ensureRepairingServiceExists() {
    let svc = await service.findOne({
      where: {
        [Op.or]: [
          { name: { [Op.like]: '%Repair%' } },
          { name: { [Op.like]: '%Alteration%' } },
        ],
      },
      order: [['id', 'ASC']],
    });

    if (!svc) {
      svc = await service.create({
        name: 'Alteration & Repair',
        description:
          'Professional alterations and repairs to restore and extend the life of your clothes.',
        status: true,
        image: null,
        timeRequired: '48-72 hours',
        pricingBasis: 'item',
        numberOfBags: false,
        numberOfItems: true,
      });
    }
    return svc;
  }

  async getCatalogForCustomer(serviceId) {
    const numericServiceId = Number(serviceId);
    if (!numericServiceId || Number.isNaN(numericServiceId)) {
      throw new ValidationError('Valid serviceId is required');
    }

    const svc = await service.findByPk(numericServiceId, {
      attributes: ['id', 'name', 'status'],
    });
    if (!svc) throw new NotFoundError('Service not found');

    const garments = await repairGarment.findAll({
      where: { status: true },
      include: [
        {
          ...OPTION_INCLUDE,
          where: { status: true },
          required: false,
        },
      ],
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
        [{ model: repairOption, as: 'options' }, 'sortOrder', 'ASC'],
        [{ model: repairOption, as: 'options' }, 'id', 'ASC'],
      ],
    });

    const garmentsOut = garments
      .map((g) => {
        const plain = g.toJSON();
        const options = (plain.options || []).map((o) => ({
          id: o.id,
          name: o.name,
          description: o.description || null,
          price: Number(o.price) || 0,
        }));
        return {
          repairGarmentId: plain.id,
          name: plain.name,
          description: plain.description || null,
          options,
        };
      })
      .filter((g) => g.options.length > 0);

    return {
      message: 'Repair catalog fetched successfully',
      data: {
        serviceId: numericServiceId,
        serviceName: svc.name,
        garments: garmentsOut,
      },
    };
  }

  async listGarments() {
    const rows = await repairGarment.findAll({
      include: [OPTION_INCLUDE],
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    return rows.map((r) => {
      const plain = r.toJSON();
      plain.repairOptionIds = (plain.options || []).map((o) => o.id);
      return plain;
    });
  }

  async listOptions() {
    return repairOption.findAll({
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    });
  }

  async createGarment({ name, description, status, repairOptionIds }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new ValidationError('Garment name is required');

    const existing = await repairGarment.findOne({ where: { name: trimmed } });
    if (existing) throw new ConflictError('Garment already exists');

    const maxSort = await repairGarment.max('sortOrder');
    const created = await repairGarment.create({
      name: trimmed,
      description: description ? String(description).trim() : null,
      status: status !== false,
      sortOrder: (Number(maxSort) || 0) + 1,
    });

    const optionIds = this._normalizeIds(repairOptionIds);
    if (optionIds.length) {
      await created.setOptions(optionIds);
    }
    return this.getGarmentById(created.id);
  }

  async updateGarment(garmentId, { name, description, status, repairOptionIds }) {
    const row = await repairGarment.findByPk(garmentId);
    if (!row) throw new NotFoundError('Repair garment not found');

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) throw new ValidationError('Garment name cannot be empty');
      row.name = trimmed;
    }
    if (description !== undefined) {
      row.description = description ? String(description).trim() : null;
    }
    if (status !== undefined) row.status = !!status;
    await row.save();

    if (repairOptionIds !== undefined) {
      await row.setOptions(this._normalizeIds(repairOptionIds));
    }
    return this.getGarmentById(row.id);
  }

  async deleteGarment(garmentId) {
    const row = await repairGarment.findByPk(garmentId);
    if (!row) throw new NotFoundError('Repair garment not found');
    await repairGarmentOption.destroy({ where: { repairGarmentId: garmentId } });
    await row.destroy();
    return { message: 'Repair garment deleted' };
  }

  async getGarmentById(garmentId) {
    const row = await repairGarment.findByPk(garmentId, {
      include: [OPTION_INCLUDE],
    });
    if (!row) throw new NotFoundError('Repair garment not found');
    const plain = row.toJSON();
    plain.repairOptionIds = (plain.options || []).map((o) => o.id);
    return plain;
  }

  async createOption({ name, description, price, status }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new ValidationError('Repair option name is required');
    const numericPrice = Number(price);
    if (Number.isNaN(numericPrice) || numericPrice < 0) {
      throw new ValidationError('Price must be a valid non-negative number');
    }

    const existing = await repairOption.findOne({ where: { name: trimmed } });
    if (existing) throw new ConflictError('Repair option already exists');

    const maxSort = await repairOption.max('sortOrder');
    return repairOption.create({
      name: trimmed,
      description: description ? String(description).trim() : null,
      price: numericPrice,
      status: status !== false,
      sortOrder: (Number(maxSort) || 0) + 1,
    });
  }

  async updateOption(optionId, { name, description, price, status }) {
    const row = await repairOption.findByPk(optionId);
    if (!row) throw new NotFoundError('Repair option not found');

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) throw new ValidationError('Repair option name cannot be empty');
      row.name = trimmed;
    }
    if (description !== undefined) {
      row.description = description ? String(description).trim() : null;
    }
    if (price !== undefined && price !== null && price !== '') {
      const numericPrice = Number(price);
      if (Number.isNaN(numericPrice) || numericPrice < 0) {
        throw new ValidationError('Price must be a valid non-negative number');
      }
      row.price = numericPrice;
    }
    if (status !== undefined) row.status = !!status;
    await row.save();
    return row;
  }

  async deleteOption(optionId) {
    const row = await repairOption.findByPk(optionId);
    if (!row) throw new NotFoundError('Repair option not found');
    await repairGarmentOption.destroy({ where: { repairOptionId: optionId } });
    await row.destroy();
    return { message: 'Repair option deleted' };
  }

  _normalizeIds(ids) {
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.map((id) => Number(id)).filter((id) => id > 0))];
  }

  /**
   * Seed default garments + options if catalog is empty.
   */
  async seedDefaultsIfEmpty() {
    await this.ensureRepairingServiceExists();

    const garmentCount = await repairGarment.count();
    const optionCount = await repairOption.count();
    if (garmentCount > 0 || optionCount > 0) {
      return { seeded: false, message: 'Repair catalog already has data' };
    }

    const optionDefs = [
      { name: 'Button resew / replace', price: 3.5 },
      { name: 'Zip repair / replace', price: 12 },
      { name: 'Hemming', price: 8 },
      { name: 'Seam repair', price: 7 },
      { name: 'Tear / hole patch', price: 10 },
      { name: 'Take in / let out', price: 15 },
      { name: 'Other alteration', price: 0 },
    ];

    const options = [];
    for (let i = 0; i < optionDefs.length; i++) {
      options.push(
        await repairOption.create({
          name: optionDefs[i].name,
          price: optionDefs[i].price,
          status: true,
          sortOrder: i + 1,
        })
      );
    }

    const garmentDefs = [
      {
        name: 'Shirt',
        optionNames: [
          'Button resew / replace',
          'Seam repair',
          'Take in / let out',
          'Other alteration',
        ],
      },
      {
        name: 'Trouser / Pants',
        optionNames: [
          'Zip repair / replace',
          'Hemming',
          'Seam repair',
          'Take in / let out',
          'Other alteration',
        ],
      },
      {
        name: 'Dress',
        optionNames: [
          'Zip repair / replace',
          'Hemming',
          'Seam repair',
          'Take in / let out',
          'Other alteration',
        ],
      },
      {
        name: 'Jacket / Coat',
        optionNames: [
          'Button resew / replace',
          'Zip repair / replace',
          'Seam repair',
          'Tear / hole patch',
          'Other alteration',
        ],
      },
      {
        name: 'Skirt',
        optionNames: [
          'Zip repair / replace',
          'Hemming',
          'Seam repair',
          'Take in / let out',
          'Other alteration',
        ],
      },
      {
        name: 'Other garment',
        optionNames: [
          'Button resew / replace',
          'Zip repair / replace',
          'Hemming',
          'Seam repair',
          'Tear / hole patch',
          'Take in / let out',
          'Other alteration',
        ],
      },
    ];

    const byName = new Map(options.map((o) => [o.name, o.id]));
    for (let i = 0; i < garmentDefs.length; i++) {
      const g = await repairGarment.create({
        name: garmentDefs[i].name,
        status: true,
        sortOrder: i + 1,
      });
      const ids = garmentDefs[i].optionNames
        .map((n) => byName.get(n))
        .filter(Boolean);
      await g.setOptions(ids);
    }

    return { seeded: true, message: 'Default repair catalog seeded' };
  }
}

module.exports = new RepairCatalogService();
