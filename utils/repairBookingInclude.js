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
    // Garments, then each garment's options and images, in a fixed order. (Sequelize honours
    // an include's own `order` only when it runs separately; nested in a parent query the
    // order comes from normalizeRepairItem.)
    order: repairItemsOrder(models),
  };
}

/** Garments by id, their options by id, their images by sortOrder then id. */
function repairItemsOrder(models) {
  return [
    ['id', 'ASC'],
    [{ model: models.customerSelectedRepairItemOption, as: 'options' }, 'id', 'ASC'],
    [{ model: models.customerSelectedRepairItemImage, as: 'images' }, 'sortOrder', 'ASC'],
    [{ model: models.customerSelectedRepairItemImage, as: 'images' }, 'id', 'ASC'],
  ];
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
    // By id: the same order whatever query (or join plan) loaded them.
    options: Array.isArray(row.options)
      ? row.options
          .map((opt) => {
            const o = opt.toJSON ? opt.toJSON() : opt;
            return {
              id: o.id,
              repairOptionId: o.repairOptionId,
              optionName: o.optionName || '',
              price: Number(o.price) || 0,
            };
          })
          .sort((a, b) => Number(a.id) - Number(b.id))
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
          .sort((a, b) => a.sortOrder - b.sortOrder || Number(a.id) - Number(b.id))
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

function repairItemRowsQuery(models, bookingId) {
  const {
    customerSelectedRepairItemOption,
    customerSelectedRepairItemImage,
  } = models;
  return {
    where: { bookingId },
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
    order: repairItemsOrder(models),
  };
}

/** What hydrate returns when the repair rows cannot be read or applied. */
function repairItemsSkipped(err, selectedServices) {
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

/**
 * Attach a booking's repair rows (already loaded) to its selected-service rows.
 * @param {Array} rows that booking's customerSelectedRepairItem rows
 */
function applyRepairItemRows(rows, selectedServices, options = {}) {
  const matchByServiceIdOnly = options.matchByServiceIdOnly === true;
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
 * @param {{ matchByServiceIdOnly?: boolean, rows?: Array }} [options]
 *   matchByServiceIdOnly: when true (customerDeclared / snapshot rows), never match on
 *   row `id` — snapshot ids live in a different sequence than customerSelectedServiceId.
 *   rows: the booking's customerSelectedRepairItem rows (with options and images) when the
 *   caller already read them for this request; they are used instead of a query.
 */
async function hydrateRepairItemsForBooking(
  models,
  bookingId,
  selectedServices,
  options = {}
) {
  if (Array.isArray(options.rows)) {
    if (
      !models.customerSelectedRepairItem ||
      !Array.isArray(selectedServices) ||
      selectedServices.length === 0 ||
      !Number.isFinite(parseInt(bookingId, 10))
    ) {
      return selectedServices;
    }
    try {
      return applyRepairItemRows(options.rows, selectedServices, options);
    } catch (err) {
      return repairItemsSkipped(err, selectedServices);
    }
  }
  const [hydrated] = await hydrateRepairItemsForBookings(
    models,
    [{ bookingId, selectedServices }],
    options
  );
  return hydrated;
}

/**
 * hydrateRepairItemsForBooking for several bookings with ONE repair-items query
 * (bookingId IN …) instead of one per booking — e.g. an agent board of N orders.
 * @param {object} models
 * @param {Array<{ bookingId: number|string, selectedServices: Array }>} entries
 * @param {{ matchByServiceIdOnly?: boolean }} [options]
 * @returns {Promise<Array>} each entry's hydrated selectedServices, in entry order
 */
async function hydrateRepairItemsForBookings(models, entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const wanted = (entry) =>
    Boolean(models.customerSelectedRepairItem) &&
    Array.isArray(entry.selectedServices) &&
    entry.selectedServices.length > 0 &&
    Number.isFinite(parseInt(entry.bookingId, 10));

  const ids = [...new Set(list.filter(wanted).map((e) => parseInt(e.bookingId, 10)))];
  let rowsByBooking = new Map();
  if (ids.length) {
    try {
      const rows = await models.customerSelectedRepairItem.findAll(
        repairItemRowsQuery(models, ids.length === 1 ? ids[0] : ids)
      );
      for (const row of rows) {
        const id = Number(row.bookingId);
        if (!rowsByBooking.has(id)) rowsByBooking.set(id, []);
        rowsByBooking.get(id).push(row);
      }
    } catch (err) {
      return list.map((e) => (wanted(e) ? repairItemsSkipped(err, e.selectedServices) : e.selectedServices));
    }
  }

  return list.map((entry) => {
    if (!wanted(entry)) return entry.selectedServices;
    try {
      return applyRepairItemRows(
        rowsByBooking.get(parseInt(entry.bookingId, 10)) || [],
        entry.selectedServices,
        options
      );
    } catch (err) {
      return repairItemsSkipped(err, entry.selectedServices);
    }
  });
}

module.exports = {
  buildRepairItemsInclude,
  buildBookingLevelRepairItemsInclude,
  repairItemsOrder,
  normalizeRepairItem,
  normalizeRepairItems,
  attachNormalizedRepairItems,
  hydrateRepairItemsForBooking,
  hydrateRepairItemsForBookings,
};
