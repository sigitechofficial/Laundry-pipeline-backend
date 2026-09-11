"use strict";

const {
  subCategories,
  addOnServices,
  repairOption,
  zoneSubCategoryOverride,
  zoneAddOnServiceOverride,
  zoneRepairOptionOverride,
  zoneServiceOverride,
  zoneCategoryOverride,
  zoneAddOnCategoryOverride,
  zoneRepairGarmentOverride,
  zoneSubCategoryAddOnOverride,
  zone,
} = require("../../models");
const { ValidationError, NotFoundError } = require("../../middlewares/universalErrorHandler");
const runtimeSettingsService = require("./runtimeSettingsService");
const {
  attachKey,
  effectiveAttach,
  money,
  mergeOverridePatch,
  effectiveDisplayPrice,
  enabledOf,
} = require("../../utils/zoneCatalogRules");
const { findZones } = require("../../utils/findZones");

async function overlaysEnabled() {
  try {
    return Boolean(
      await runtimeSettingsService.getBoolean("zoneCatalogOverridesEnabled")
    );
  } catch {
    return ["true", "1", "yes", "on"].includes(
      String(process.env.ZONE_CATALOG_OVERRIDES || "")
        .trim()
        .toLowerCase()
    );
  }
}

async function loadMaps(zoneId) {
  const id = Number(zoneId);
  if (!Number.isFinite(id) || id <= 0) {
    return {
      service: new Map(),
      category: new Map(),
      item: new Map(),
      addOnCategory: new Map(),
      addOn: new Map(),
      repairGarment: new Map(),
      repairOption: new Map(),
      attach: new Map(),
    };
  }

  const [
    services,
    categories,
    items,
    addOnCats,
    addOns,
    garments,
    options,
    attaches,
  ] = await Promise.all([
    zoneServiceOverride.findAll({ where: { zoneId: id } }),
    zoneCategoryOverride.findAll({ where: { zoneId: id } }),
    zoneSubCategoryOverride.findAll({ where: { zoneId: id } }),
    zoneAddOnCategoryOverride.findAll({ where: { zoneId: id } }),
    zoneAddOnServiceOverride.findAll({ where: { zoneId: id } }),
    zoneRepairGarmentOverride.findAll({ where: { zoneId: id } }),
    zoneRepairOptionOverride.findAll({ where: { zoneId: id } }),
    zoneSubCategoryAddOnOverride.findAll({ where: { zoneId: id } }),
  ]);

  const asMap = (rows, key) => {
    const map = new Map();
    for (const row of rows) map.set(Number(row[key]), row);
    return map;
  };

  const attach = new Map();
  for (const row of attaches) {
    const itemId = Number(row.subCategoryId);
    if (!attach.has(itemId)) attach.set(itemId, new Map());
    attach.get(itemId).set(Number(row.addOnCategoryId), row);
  }

  return {
    service: asMap(services, "serviceId"),
    category: asMap(categories, "categoryId"),
    item: asMap(items, "subCategoryId"),
    addOnCategory: asMap(addOnCats, "addOnCategoryId"),
    addOn: asMap(addOns, "addOnServiceId"),
    repairGarment: asMap(garments, "repairGarmentId"),
    repairOption: asMap(options, "repairOptionId"),
    attach,
  };
}

async function resolveCatalogZoneId({ lat, lng, zoneId } = {}) {
  let catalogZoneId = Number(zoneId) > 0 ? Number(zoneId) : null;
  if (!catalogZoneId && lat != null && lng != null) {
    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);
    if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng)) {
      const matched = await findZones(parsedLat, parsedLng);
      catalogZoneId = matched?.[0]?.id || null;
    }
  }
  return catalogZoneId;
}

async function filterEnabledServices(list, zoneId) {
  if (!zoneId) return list || [];
  const maps = await loadMaps(zoneId);
  return (list || []).filter((svc) =>
    enabledOf(maps.service.get(Number(svc.id ?? svc.serviceId)))
  );
}

async function resolvePrice(zoneId, selector = {}) {
  const enabled = await overlaysEnabled();
  if (selector.subCategoryId) {
    const master = await subCategories.findByPk(selector.subCategoryId, {
      attributes: ["id", "price", "status"],
    });
    if (!master) throw new NotFoundError("Item not found");
    if (!enabled || !zoneId) {
      return { price: money(master.price), inherited: true, source: "master" };
    }
    const maps = await loadMaps(zoneId);
    const ov = maps.item.get(Number(selector.subCategoryId));
    if (ov && ov.price != null && ov.price !== "") {
      return { price: money(ov.price), inherited: false, source: "override" };
    }
    return { price: money(master.price), inherited: true, source: "master" };
  }

  if (selector.addOnServiceId) {
    const master = await addOnServices.findByPk(selector.addOnServiceId, {
      attributes: ["id", "price"],
    });
    if (!master) throw new NotFoundError("Add-on not found");
    if (!enabled || !zoneId) {
      return { price: money(master.price), inherited: true, source: "master" };
    }
    const maps = await loadMaps(zoneId);
    const ov = maps.addOn.get(Number(selector.addOnServiceId));
    if (ov && ov.price != null && ov.price !== "") {
      return { price: money(ov.price), inherited: false, source: "override" };
    }
    return { price: money(master.price), inherited: true, source: "master" };
  }

  if (selector.repairOptionId) {
    const master = await repairOption.findByPk(selector.repairOptionId, {
      attributes: ["id", "price", "status"],
    });
    if (!master) throw new NotFoundError("Repair option not found");
    if (!enabled || !zoneId) {
      return { price: money(master.price), inherited: true, source: "master" };
    }
    const maps = await loadMaps(zoneId);
    const ov = maps.repairOption.get(Number(selector.repairOptionId));
    if (ov && ov.price != null && ov.price !== "") {
      return { price: money(ov.price), inherited: false, source: "override" };
    }
    return { price: money(master.price), inherited: true, source: "master" };
  }

  throw new ValidationError("resolvePrice requires subCategoryId, addOnServiceId, or repairOptionId");
}

function applyItemPrice(plain, maps, overlaysOn) {
  const ov = overlaysOn ? maps.item.get(Number(plain.id)) : null;
  if (ov && ov.price != null && ov.price !== "") {
    return { ...plain, price: money(ov.price), priceInherited: false };
  }
  return { ...plain, price: money(plain.price), priceInherited: true };
}

async function applyToServiceCategoriesData(tree, zoneId, serviceId) {
  if (!zoneId) return tree;
  const overlaysOn = await overlaysEnabled();
  const maps = await loadMaps(zoneId);
  if (serviceId && !enabledOf(maps.service.get(Number(serviceId)))) {
    return [];
  }

  const out = [];
  for (const row of tree || []) {
    const catId = Number(row.categoryId);
    if (!enabledOf(maps.category.get(catId))) continue;
    const items = (row.category?.subCategories || [])
      .map((sub) => (sub.toJSON ? sub.toJSON() : sub))
      .filter((plain) => enabledOf(maps.item.get(Number(plain.id))))
      .map((plain) => applyItemPrice(plain, maps, overlaysOn));
    if (!items.length) continue;
    out.push({
      ...row,
      category: {
        ...row.category,
        subCategories: items,
      },
    });
  }
  return out;
}

async function findOrRestore(model, where, defaults) {
  const existing = await model.findOne({ where, paranoid: false });
  if (!existing) {
    const created = await model.create({ ...where, ...defaults });
    return [created, true];
  }
  if (existing.deletedAt) {
    await existing.restore();
    await existing.update({ ...defaults, version: 1 });
    await existing.reload();
    return [existing, true];
  }
  return [existing, false];
}

async function loadMasterAttachMap() {
  const {
    subCategoryAddOnCategory,
    categoryAddOnCategory,
    subCategoryExcludedAddOnCategory,
    subCategories,
    addOnCategory,
  } = require("../../models");

  const [items, directs, inherited, excluded, cats] = await Promise.all([
    subCategories.findAll({
      attributes: ["id", "categoryId"],
      where: { status: true },
    }),
    subCategoryAddOnCategory.findAll(),
    categoryAddOnCategory.findAll(),
    subCategoryExcludedAddOnCategory.findAll(),
    addOnCategory.findAll({
      attributes: ["id", "name", "status"],
      order: [["id", "ASC"]],
    }),
  ]);

  const inheritByCat = new Map();
  for (const row of inherited) {
    const cid = Number(row.categoryId);
    if (!inheritByCat.has(cid)) inheritByCat.set(cid, []);
    inheritByCat.get(cid).push(Number(row.addOnCategoryId));
  }
  const exclude = new Set(
    excluded.map((r) => attachKey(r.subCategoryId, r.addOnCategoryId))
  );
  const byItem = new Map();
  for (const item of items) {
    const set = new Set();
    for (const d of directs) {
      if (Number(d.subCategoryId) === Number(item.id)) {
        set.add(Number(d.addOnCategoryId));
      }
    }
    for (const acId of inheritByCat.get(Number(item.categoryId)) || []) {
      if (!exclude.has(attachKey(item.id, acId))) set.add(acId);
    }
    byItem.set(Number(item.id), set);
  }
  return { byItem, categories: cats };
}

async function isAddOnCategoryAttached(zoneId, subCategoryId, addOnCategoryId, masterAttached) {
  if (!zoneId) return Boolean(masterAttached);
  const maps = await loadMaps(zoneId);
  const itemMap = maps.attach.get(Number(subCategoryId));
  const ov = itemMap?.get(Number(addOnCategoryId));
  return effectiveAttach(
    masterAttached,
    ov,
    enabledOf(maps.addOnCategory.get(Number(addOnCategoryId)))
  );
}

async function applyToAddOnRows(rows, zoneId, { subCategoryId } = {}) {
  const overlaysOn = await overlaysEnabled();
  const mapped = (rows || []).map((row) => {
    const plain = row.toJSON ? row.toJSON() : row;
    return { ...plain, price: money(plain.price), priceInherited: true };
  });
  if (!zoneId) {
    return mapped;
  }
  const maps = await loadMaps(zoneId);
  let masterAttach = null;
  if (subCategoryId) {
    const attachMap = await loadMasterAttachMap();
    masterAttach = attachMap.byItem.get(Number(subCategoryId)) || new Set();
  }
  return mapped
    .filter((plain) => {
      const catId = Number(plain.addOnCategoryId || plain.addOnCategory?.id || plain.category?.id);
      if (catId && !enabledOf(maps.addOnCategory.get(catId))) return false;
      if (!enabledOf(maps.addOn.get(Number(plain.id)))) return false;
      if (masterAttach && catId) {
        const itemMap = maps.attach.get(Number(subCategoryId));
        return effectiveAttach(
          masterAttach.has(catId),
          itemMap?.get(catId),
          true
        );
      }
      return true;
    })
    .map((plain) => {
      if (!overlaysOn) return plain;
      const ov = maps.addOn.get(Number(plain.id));
      if (ov && ov.price != null && ov.price !== "") {
        return { ...plain, price: money(ov.price), priceInherited: false };
      }
      return { ...plain, price: money(plain.price), priceInherited: true };
    });
}

async function applyToRepairOptions(options, zoneId) {
  const overlaysOn = await overlaysEnabled();
  const mapped = (options || []).map((row) => {
    const plain = row.toJSON ? row.toJSON() : row;
    return { ...plain, price: money(plain.price), priceInherited: true };
  });
  if (!zoneId) return mapped;
  const maps = await loadMaps(zoneId);
  return mapped
    .filter((plain) => enabledOf(maps.repairOption.get(Number(plain.id))))
    .map((plain) => {
      if (!overlaysOn) return plain;
      const ov = maps.repairOption.get(Number(plain.id));
      if (ov && ov.price != null && ov.price !== "") {
        return { ...plain, price: money(ov.price), priceInherited: false };
      }
      return { ...plain, price: money(plain.price), priceInherited: true };
    });
}

async function applyToRepairGarments(garments, zoneId) {
  if (!zoneId) {
    const mapped = [];
    for (const g of garments || []) {
      const plain = g.toJSON ? g.toJSON() : g;
      mapped.push({
        ...plain,
        options: await applyToRepairOptions(plain.options || [], null),
      });
    }
    return mapped;
  }
  const maps = await loadMaps(zoneId);
  const out = [];
  for (const g of garments || []) {
    const plain = g.toJSON ? g.toJSON() : g;
    if (!enabledOf(maps.repairGarment.get(Number(plain.id)))) continue;
    out.push({
      ...plain,
      options: await applyToRepairOptions(plain.options || [], zoneId),
    });
  }
  return out;
}

const UPSERT_TYPES = {
  service: { model: zoneServiceOverride, key: "serviceId", hasPrice: false },
  category: { model: zoneCategoryOverride, key: "categoryId", hasPrice: false },
  item: { model: zoneSubCategoryOverride, key: "subCategoryId", hasPrice: true },
  addOnCategory: {
    model: zoneAddOnCategoryOverride,
    key: "addOnCategoryId",
    hasPrice: false,
  },
  addOn: { model: zoneAddOnServiceOverride, key: "addOnServiceId", hasPrice: true },
  repairGarment: {
    model: zoneRepairGarmentOverride,
    key: "repairGarmentId",
    hasPrice: false,
  },
  repairOption: {
    model: zoneRepairOptionOverride,
    key: "repairOptionId",
    hasPrice: true,
  },
};

async function upsertOverride(zoneId, type, payload = {}, { adminUserId } = {}) {
  const spec = UPSERT_TYPES[type];
  if (!spec) throw new ValidationError(`Unknown override type: ${type}`);
  const entityId = Number(payload[spec.key] ?? payload.entityId);
  if (!Number.isFinite(entityId) || entityId <= 0) {
    throw new ValidationError(`${spec.key} is required`);
  }
  if (payload.expectedVersion != null) {
    const existing = await spec.model.findOne({
      where: { zoneId, [spec.key]: entityId },
    });
    if (existing && Number(existing.version) !== Number(payload.expectedVersion)) {
      throw new ValidationError(
        `Stale override (expected version ${payload.expectedVersion}, have ${existing.version})`
      );
    }
  }

  const existing = await spec.model.findOne({
    where: { zoneId, [spec.key]: entityId },
    paranoid: false,
  });
  const creating = !existing || Boolean(existing.deletedAt);
  const patch = mergeOverridePatch(payload, {
    hasPrice: spec.hasPrice,
    creating,
  });
  const [row, created] = await findOrRestore(
    spec.model,
    { zoneId, [spec.key]: entityId },
    { ...patch, version: 1 }
  );
  if (!created) {
    await row.update({
      ...patch,
      version: Number(row.version || 1) + 1,
    });
    await row.reload();
  }
  return {
    ...row.get({ plain: true }),
    type,
    created,
    adminUserId: adminUserId || null,
  };
}

async function upsertAttach(zoneId, { subCategoryId, addOnCategoryId, isEnabled, expectedVersion }, { adminUserId } = {}) {
  const itemId = Number(subCategoryId);
  const catId = Number(addOnCategoryId);
  if (!itemId || !catId) {
    throw new ValidationError("subCategoryId and addOnCategoryId are required");
  }
  const existing = await zoneSubCategoryAddOnOverride.findOne({
    where: { zoneId, subCategoryId: itemId, addOnCategoryId: catId },
    paranoid: false,
  });
  if (
    existing &&
    !existing.deletedAt &&
    expectedVersion != null &&
    Number(existing.version) !== Number(expectedVersion)
  ) {
    throw new ValidationError("Stale attach override");
  }
  const [row, created] = await findOrRestore(
    zoneSubCategoryAddOnOverride,
    { zoneId, subCategoryId: itemId, addOnCategoryId: catId },
    { isEnabled: isEnabled !== false, version: 1 }
  );
  if (!created) {
    await row.update({
      isEnabled: isEnabled !== false,
      version: Number(row.version || 1) + 1,
    });
    await row.reload();
  }
  return {
    ...row.get({ plain: true }),
    created,
    adminUserId: adminUserId || null,
  };
}

async function resetOverride(zoneId, type, entityId, extra = {}) {
  if (type === "attach") {
    const row = await zoneSubCategoryAddOnOverride.findOne({
      where: {
        zoneId,
        subCategoryId: extra.subCategoryId,
        addOnCategoryId: extra.addOnCategoryId,
      },
    });
    if (row) await row.destroy();
    return { reset: true };
  }
  const spec = UPSERT_TYPES[type];
  if (!spec) throw new ValidationError(`Unknown override type: ${type}`);
  const row = await spec.model.findOne({
    where: { zoneId, [spec.key]: Number(entityId) },
  });
  if (row) await row.destroy();
  return { reset: true };
}

async function copyOverrides(fromZoneId, toZoneId, { replace = false } = {}) {
  const from = Number(fromZoneId);
  const to = Number(toZoneId);
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) {
    throw new ValidationError("fromZoneId and zoneId are required");
  }
  if (from === to) {
    throw new ValidationError("Cannot copy a zone onto itself");
  }
  const pairs = [
    [zoneServiceOverride, ["serviceId", "isEnabled", "sortOrder"]],
    [zoneCategoryOverride, ["categoryId", "isEnabled", "sortOrder"]],
    [zoneSubCategoryOverride, ["subCategoryId", "isEnabled", "sortOrder", "price"]],
    [zoneAddOnCategoryOverride, ["addOnCategoryId", "isEnabled", "sortOrder"]],
    [zoneAddOnServiceOverride, ["addOnServiceId", "isEnabled", "sortOrder", "price"]],
    [zoneRepairGarmentOverride, ["repairGarmentId", "isEnabled", "sortOrder"]],
    [zoneRepairOptionOverride, ["repairOptionId", "isEnabled", "sortOrder", "price"]],
  ];

  let copied = 0;
  for (const [model, fields] of pairs) {
    if (replace) {
      await model.destroy({ where: { zoneId: to } });
    }
    const rows = await model.findAll({ where: { zoneId: from } });
    for (const row of rows) {
      const payload = { zoneId: to, version: 1 };
      for (const f of fields) payload[f] = row[f];
      const keys = { zoneId: to, [fields[0]]: row[fields[0]] };
      const [target, created] = await findOrRestore(model, keys, payload);
      if (!created) {
        await target.update({ ...payload, version: Number(target.version || 1) + 1 });
      }
      copied += 1;
    }
  }

  if (replace) {
    await zoneSubCategoryAddOnOverride.destroy({ where: { zoneId: to } });
  }
  const attachRows = await zoneSubCategoryAddOnOverride.findAll({
    where: { zoneId: from },
  });
  for (const row of attachRows) {
    const keys = {
      zoneId: to,
      subCategoryId: row.subCategoryId,
      addOnCategoryId: row.addOnCategoryId,
    };
    const [target, created] = await findOrRestore(
      zoneSubCategoryAddOnOverride,
      keys,
      { isEnabled: row.isEnabled, version: 1 }
    );
    if (!created) {
      await target.update({
        isEnabled: row.isEnabled,
        version: Number(target.version || 1) + 1,
      });
    }
    copied += 1;
  }

  return { copied };
}

function catalogLinePrice(masterPrice, overrideRow, overlaysOn) {
  return effectiveDisplayPrice(
    masterPrice,
    overrideRow && overrideRow.price != null && overrideRow.price !== ""
      ? overrideRow.price
      : null,
    overlaysOn
  );
}

async function assertLineEnabled(zoneId, { serviceId, categoryId, subCategoryId } = {}) {
  if (!zoneId) return;
  const maps = await loadMaps(zoneId);
  if (serviceId && !enabledOf(maps.service.get(Number(serviceId)))) {
    throw new ValidationError("Service is not available in this zone");
  }
  if (categoryId && !enabledOf(maps.category.get(Number(categoryId)))) {
    throw new ValidationError("Category is not available in this zone");
  }
  if (subCategoryId && !enabledOf(maps.item.get(Number(subCategoryId)))) {
    throw new ValidationError("Item is not available in this zone");
  }
}

async function getEffectiveCatalog(zoneId) {
  const serviceManagementService = require("./serviceManagementService");
  const addOnServicesService = require("./addOnServicesService");
  const repairCatalogService = require("./repairCatalogService");
  const { service } = require("../../models");
  const enabled = await overlaysEnabled();
  const maps = zoneId ? await loadMaps(zoneId) : await loadMaps(0);
  const masterAttach = await loadMasterAttachMap();
  const services = await service.findAll({
    where: { status: true },
    attributes: ["id", "name", "status", "image", "description", "sortOrder"],
    order: [["sortOrder", "ASC"], ["id", "ASC"]],
  });

  const tree = [];
  for (const svc of services) {
    const cats = await serviceManagementService.getServiceCategoriesDataForService(svc.id);
    const sov = maps.service.get(Number(svc.id));
    tree.push({
      serviceId: svc.id,
      name: svc.name,
      inherited: !sov,
      isEnabled: enabledOf(sov),
      categories: (cats || []).map((row) => ({
        categoryId: row.categoryId,
        name: row.category?.name,
        inherited: !maps.category.get(Number(row.categoryId)),
        isEnabled: enabledOf(maps.category.get(Number(row.categoryId))),
        items: (row.category?.subCategories || []).map((item) => {
          const plain = item.toJSON ? item.toJSON() : item;
          const itemId = Number(plain.id);
          const ov = maps.item.get(itemId);
          const priced = catalogLinePrice(plain.price, ov, enabled);
          const masterIds = masterAttach.byItem.get(itemId) || new Set();
          const attach = [...masterIds].map((addOnCategoryId) => {
            const attachOv = maps.attach.get(itemId)?.get(addOnCategoryId);
            const cat = masterAttach.categories.find(
              (c) => Number(c.id) === addOnCategoryId
            );
            return {
              addOnCategoryId,
              name: cat?.name || `Add-on category ${addOnCategoryId}`,
              masterAttached: true,
              isEnabled: effectiveAttach(
                true,
                attachOv,
                enabledOf(maps.addOnCategory.get(addOnCategoryId))
              ),
              inherited: !attachOv,
            };
          });
          return {
            subCategoryId: plain.id,
            name: plain.name,
            price: priced.price,
            priceInherited: priced.inherited,
            staged: priced.staged,
            unitCount: plain.unitCount ?? null,
            inherited: !ov,
            isEnabled: enabledOf(ov),
            attach,
          };
        }),
      })),
    });
  }

  const addOnRows = await addOnServicesService.getAllAddOnServices({
    activeOnly: true,
  });
  const addOnCats = [];
  const seenCat = new Set();
  for (const row of addOnRows) {
    const catId = Number(row.addOnCategoryId || row.category?.id);
    if (!catId || seenCat.has(catId)) continue;
    seenCat.add(catId);
    const cov = maps.addOnCategory.get(catId);
    addOnCats.push({
      addOnCategoryId: catId,
      name: row.category?.name || `Category ${catId}`,
      inherited: !cov,
      isEnabled: enabledOf(cov),
      addOns: addOnRows
        .filter((a) => Number(a.addOnCategoryId || a.category?.id) === catId)
        .map((a) => {
          const aov = maps.addOn.get(Number(a.id));
          const priced = catalogLinePrice(a.price, aov, enabled);
          return {
            addOnServiceId: a.id,
            name: a.name,
            price: priced.price,
            priceInherited: priced.inherited,
            staged: priced.staged,
            inherited: !aov,
            isEnabled: enabledOf(aov),
          };
        }),
    });
  }

  let repair = [];
  try {
    const garments = await repairCatalogService.listGarments();
    repair = (garments || []).map((g) => {
      const plain = g.toJSON ? g.toJSON() : g;
      const gov = maps.repairGarment.get(Number(plain.id));
      return {
        repairGarmentId: plain.id,
        name: plain.name,
        inherited: !gov,
        isEnabled: enabledOf(gov),
        options: (plain.options || []).map((opt) => {
          const option = opt.toJSON ? opt.toJSON() : opt;
          const oov = maps.repairOption.get(Number(option.id));
          const priced = catalogLinePrice(option.price, oov, enabled);
          return {
            repairOptionId: option.id,
            name: option.name,
            price: priced.price,
            priceInherited: priced.inherited,
            staged: priced.staged,
            inherited: !oov,
            isEnabled: enabledOf(oov),
          };
        }),
      };
    });
  } catch (err) {
    console.warn("[zoneCatalog] repair tree skipped:", err.message);
  }

  return {
    zoneId: zoneId ? Number(zoneId) : null,
    overlaysEnabled: enabled,
    services: tree,
    addOnCategories: addOnCats,
    repair,
  };
}

async function repriceCart(zoneId, cart = {}) {
  const parseIds = (value) =>
    (Array.isArray(value) ? value : String(value || "").split(","))
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0);

  const overlaysOn = await overlaysEnabled();
  const maps = overlaysOn && zoneId ? await loadMaps(zoneId) : null;
  const items = [];
  const dropped = [];
  for (const subCategoryId of parseIds(cart.subCategoryIds)) {
    try {
      if (maps && !enabledOf(maps.item.get(subCategoryId))) {
        dropped.push({ type: "item", id: subCategoryId });
        continue;
      }
      const resolved = await resolvePrice(zoneId, { subCategoryId });
      items.push({
        type: "item",
        id: subCategoryId,
        price: resolved.price,
        inherited: resolved.inherited,
      });
    } catch {
      dropped.push({ type: "item", id: subCategoryId });
    }
  }
  const addOns = [];
  for (const addOnServiceId of parseIds(cart.addOnServiceIds)) {
    try {
      if (maps && !enabledOf(maps.addOn.get(addOnServiceId))) {
        dropped.push({ type: "addOn", id: addOnServiceId });
        continue;
      }
      const resolved = await resolvePrice(zoneId, { addOnServiceId });
      addOns.push({
        type: "addOn",
        id: addOnServiceId,
        price: resolved.price,
        inherited: resolved.inherited,
      });
    } catch {
      dropped.push({ type: "addOn", id: addOnServiceId });
    }
  }
  const repairs = [];
  for (const repairOptionId of parseIds(cart.repairOptionIds)) {
    try {
      if (maps && !enabledOf(maps.repairOption.get(repairOptionId))) {
        dropped.push({ type: "repairOption", id: repairOptionId });
        continue;
      }
      const resolved = await resolvePrice(zoneId, { repairOptionId });
      repairs.push({
        type: "repairOption",
        id: repairOptionId,
        price: resolved.price,
        inherited: resolved.inherited,
      });
    } catch {
      dropped.push({ type: "repairOption", id: repairOptionId });
    }
  }
  return { zoneId: zoneId ? Number(zoneId) : null, items, addOns, repairs, dropped };
}

async function healthProbe() {
  const enabled = await overlaysEnabled();
  const tables = {
    zoneServiceOverrides: await zoneServiceOverride.count(),
    zoneCategoryOverrides: await zoneCategoryOverride.count(),
    zoneSubCategoryOverrides: await zoneSubCategoryOverride.count(),
    zoneAddOnCategoryOverrides: await zoneAddOnCategoryOverride.count(),
    zoneAddOnServiceOverrides: await zoneAddOnServiceOverride.count(),
    zoneRepairGarmentOverrides: await zoneRepairGarmentOverride.count(),
    zoneRepairOptionOverrides: await zoneRepairOptionOverride.count(),
    zoneSubCategoryAddOnOverrides: await zoneSubCategoryAddOnOverride.count(),
  };
  const firstZone = await zone.findOne({
    where: { status: true },
    attributes: ["id", "name"],
    order: [["id", "ASC"]],
  });
  let sample = null;
  const firstItem = await subCategories.findOne({
    where: { status: true },
    attributes: ["id", "name", "price"],
  });
  if (firstItem) {
    const resolved = await resolvePrice(firstZone?.id, {
      subCategoryId: firstItem.id,
    });
    sample = {
      subCategoryId: firstItem.id,
      masterPrice: money(firstItem.price),
      resolvedPrice: resolved.price,
      inherited: resolved.inherited,
      matchesMasterWhenInherited: resolved.inherited
        ? resolved.price === money(firstItem.price)
        : true,
    };
  }
  return {
    overlaysEnabled: enabled,
    tables,
    sampleZone: firstZone ? { id: firstZone.id, name: firstZone.name } : null,
    sample,
    ok: !sample || sample.matchesMasterWhenInherited,
  };
}

module.exports = {
  overlaysEnabled,
  resolveCatalogZoneId,
  filterEnabledServices,
  resolvePrice,
  applyToServiceCategoriesData,
  applyToAddOnRows,
  applyToRepairOptions,
  applyToRepairGarments,
  isAddOnCategoryAttached,
  getEffectiveCatalog,
  upsertOverride,
  upsertAttach,
  resetOverride,
  copyOverrides,
  healthProbe,
  attachKey,
  repriceCart,
  effectiveAttach,
  assertLineEnabled,
};
