'use strict';

/**
 * Shared Sequelize include + normalizers for customer repair/alteration lines.
 * Used by customer, admin, and agent booking/invoice detail responses.
 */

const { lineOwnsRepairGarments } = require('./invoiceLineTotals');

function buildRepairItemsInclude(models, { separate = false } = {}) {
  const {
    customerSelectedRepairItem,
    customerSelectedRepairItemOption,
    customerSelectedRepairItemImage,
  } = models;

  if (!customerSelectedRepairItem) {
    return null;
  }

  return {
    model: customerSelectedRepairItem,
    as: 'repairItems',
    required: false,
    separate,
    attributes: [
      'id',
      'bookingId',
      'customerSelectedServiceId',
      'serviceId',
      'repairGarmentId',
      'garmentName',
      'quantity',
      'instruction',
      'createdAt',
    ],
    include: [
      {
        model: customerSelectedRepairItemOption,
        as: 'options',
        required: false,
        attributes: [
          'id',
          'repairOptionId',
          'optionName',
          'price',
        ],
      },
      {
        model: customerSelectedRepairItemImage,
        as: 'images',
        required: false,
        attributes: ['id', 'imageUrl', 'sortOrder'],
      },
    ],
    order: [['id', 'ASC']],
  };
}

function buildBookingLevelRepairItemsInclude(models) {
  const include = buildRepairItemsInclude(models, { separate: true });
  if (!include) return null;
  return include;
}

function normalizeRepairItem(raw) {
  if (!raw) return null;
  const row = raw.toJSON ? raw.toJSON() : raw;
  return {
    id: row.id,
    bookingId: row.bookingId ?? null,
    customerSelectedServiceId: row.customerSelectedServiceId ?? null,
    serviceId: row.serviceId ?? null,
    createdAt: row.createdAt || null,
    repairGarmentId: row.repairGarmentId,
    garmentName: row.garmentName || '',
    quantity: Number(row.quantity) || 1,
    instruction: row.instruction || null,
    options: Array.isArray(row.options)
      ? row.options.map((opt) => {
          const o = opt.toJSON ? opt.toJSON() : opt;
          return {
            id: o.id,
            repairOptionId: o.repairOptionId,
            optionName: o.optionName || '',
            price: Number(o.price) || 0,
          };
        })
      : [],
    images: Array.isArray(row.images)
      ? row.images
          .map((img) => {
            const i = img.toJSON ? img.toJSON() : img;
            return {
              id: i.id,
              imageUrl: i.imageUrl || '',
              sortOrder: Number(i.sortOrder) || 0,
            };
          })
          .filter((i) => i.imageUrl)
          .sort((a, b) => a.sortOrder - b.sortOrder)
      : [],
  };
}

function normalizeRepairItems(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeRepairItem).filter(Boolean);
}

/**
 * Attach normalized repairItems onto each selected-service plain object.
 * Also sets top-level booking.repairItems when present.
 */
function attachNormalizedRepairItems(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  if (Array.isArray(payload.customerSelectedServices)) {
    payload.customerSelectedServices = payload.customerSelectedServices.map(
      (svc) => {
        const plain = svc && typeof svc === 'object' ? { ...svc } : svc;
        if (!plain || typeof plain !== 'object') return plain;
        plain.repairItems = normalizeRepairItems(plain.repairItems);
        return plain;
      }
    );
  }

  if (Array.isArray(payload.repairItems)) {
    payload.repairItems = normalizeRepairItems(payload.repairItems);
  }

  if (Array.isArray(payload.bookingSelectedServices)) {
    payload.bookingSelectedServices = payload.bookingSelectedServices.map(
      (svc) => {
        const plain = svc && typeof svc === 'object' ? { ...svc } : svc;
        if (!plain || typeof plain !== 'object') return plain;
        plain.repairItems = normalizeRepairItems(plain.repairItems);
        return plain;
      }
    );
  }

  return payload;
}

/**
 * Explicit hydrate when nested includes are empty/missing (mirrors add-on hydrate).
 * Never throws to callers — returns original selectedServices on failure so booking
 * / invoice detail APIs stay healthy even if repair tables are unavailable.
 */
/**
 * @param {object} models
 * @param {number|string} bookingId
 * @param {Array} selectedServices
 * @param {{ matchByServiceIdOnly?: boolean }} [options]
 *   When true (customerDeclared / snapshot rows), never match on row `id` —
 *   snapshot ids live in a different sequence than customerSelectedServiceId.
 */
async function hydrateRepairItemsForBooking(
  models,
  bookingId,
  selectedServices,
  options = {}
) {
  try {
    const {
      customerSelectedRepairItem,
      customerSelectedRepairItemOption,
      customerSelectedRepairItemImage,
    } = models;
    const matchByServiceIdOnly = options.matchByServiceIdOnly === true;

    if (
      !customerSelectedRepairItem ||
      !Array.isArray(selectedServices) ||
      selectedServices.length === 0
    ) {
      return selectedServices;
    }

    const id = parseInt(bookingId, 10);
    if (!Number.isFinite(id)) return selectedServices;

    const rows = await customerSelectedRepairItem.findAll({
      where: { bookingId: id },
      attributes: [
        'id',
        'bookingId',
        'customerSelectedServiceId',
        'serviceId',
        'repairGarmentId',
        'garmentName',
        'quantity',
        'instruction',
        'createdAt',
      ],
      include: [
        {
          model: customerSelectedRepairItemOption,
          as: 'options',
          required: false,
          attributes: ['id', 'repairOptionId', 'optionName', 'price'],
        },
        {
          model: customerSelectedRepairItemImage,
          as: 'images',
          required: false,
          attributes: ['id', 'imageUrl', 'sortOrder'],
        },
      ],
      order: [['id', 'ASC']],
    });

    const byCssId = {};
    const byServiceId = {};
    // How many selected-service rows exist per service. Once an agent itemises an
    // alteration booking there is one row per priced line, and the booking-level
    // garments are a per-service total — copying that total onto every line is
    // what inflated both "total items" and line subtotals.
    const rowCountByServiceId = {};
    for (const svc of selectedServices) {
      const sid = svc && svc.serviceId != null ? Number(svc.serviceId) : null;
      if (sid == null || Number.isNaN(sid)) continue;
      if (svc && svc.status === false) continue;
      rowCountByServiceId[sid] = (rowCountByServiceId[sid] || 0) + 1;
    }

    for (const row of rows) {
      const normalized = normalizeRepairItem(row);
      const cssId = normalized.customerSelectedServiceId;
      const serviceId = normalized.serviceId;
      if (cssId != null) {
        if (!byCssId[cssId]) byCssId[cssId] = [];
        byCssId[cssId].push(normalized);
      }
      if (serviceId != null) {
        if (!byServiceId[serviceId]) byServiceId[serviceId] = [];
        byServiceId[serviceId].push(normalized);
      }
    }

    return selectedServices.map((svc) => {
      const plain = svc && typeof svc === 'object' ? { ...svc } : svc;
      if (!plain || typeof plain !== 'object') return plain;

      const cssId = plain.id != null ? Number(plain.id) : null;
      const serviceId = plain.serviceId != null ? Number(plain.serviceId) : null;

      let items = [];
      let source = null;
      // Prefer serviceId — snapshot row ids ≠ customerSelectedServiceId, so CSS-id
      // matching wrongly empties or mis-attaches repair garments / notes / photos.
      if (serviceId != null && byServiceId[serviceId]?.length) {
        items = byServiceId[serviceId];
        source = 'service';
      } else if (
        !matchByServiceIdOnly &&
        cssId != null &&
        byCssId[cssId]?.length
      ) {
        items = byCssId[cssId];
        source = 'line';
      } else if (Array.isArray(plain.repairItems) && plain.repairItems.length) {
        items = normalizeRepairItems(plain.repairItems);
        source = 'line';
      }

      plain.repairItems = items;
      plain.repairItemsSource = items.length ? source : null;

      const singleRowForService =
        serviceId == null || (rowCountByServiceId[serviceId] || 0) <= 1;
      const ownsGarments =
        items.length > 0 &&
        (source === 'line' ||
          (singleRowForService && lineOwnsRepairGarments(plain, items)));
      plain.repairItemsSharedAcrossLines = items.length > 0 && !ownsGarments;

      const pieceSum = items.reduce((n, item) => {
        const qty = Number(item?.quantity);
        return n + (Number.isFinite(qty) && qty > 0 ? qty : 1);
      }, 0);
      const currentItems = Number(plain.items) || 0;
      // Only lift `items` on the line the garments belong to. Agent-priced lines
      // keep their own quantity.
      if (pieceSum > 0 && pieceSum > currentItems && ownsGarments) {
        plain.items = pieceSum;
      }
      return plain;
    });
  } catch (err) {
    console.warn(
      '[hydrateRepairItemsForBooking] skipped:',
      err?.message || err
    );
    if (!Array.isArray(selectedServices)) return selectedServices;
    return selectedServices.map((svc) => {
      if (!svc || typeof svc !== 'object') return svc;
      return {
        ...svc,
        repairItems: Array.isArray(svc.repairItems)
          ? normalizeRepairItems(svc.repairItems)
          : [],
      };
    });
  }
}

module.exports = {
  buildRepairItemsInclude,
  buildBookingLevelRepairItemsInclude,
  normalizeRepairItem,
  normalizeRepairItems,
  attachNormalizedRepairItems,
  hydrateRepairItemsForBooking,
};
