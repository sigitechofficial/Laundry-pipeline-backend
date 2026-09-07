# Zone catalog overlays — architecture

Canonical product + engineering contract. Implementation plan: Cursor plan `zone_catalog_overrides`.

**Status:** shipped behind flag `ZONE_CATALOG_OVERRIDES` / runtime `zoneCatalogOverridesEnabled` (**default false**). Tables, resolver, browse/charge wires, `/health/catalog-resolver`, and Admin → Zone Catalog are in code. Keep the flag off until staging: two zones, item + add-on + repair prices, attach hide, edit-order, rebook.

## What we are building

One **master catalog** (services, categories, items, add-ons, repair).  
Per **zone**: price, on/off, sort, and which add-on categories attach to which item.

New zone = inherit master. No clone. No seed of prices.

```
Master (identity + default price)
    + zone overlays (optional)
    → zoneCatalogService.resolve*(zoneId, …)
    → browse AND every price write
Past orders → snapshot on the line, never remaster
```

## Product locks

- Admin adds SKUs **once** on master. Zone UI does not create items.
- Zone differs by **price / availability / sort / item↔add-on attach** only.
- Names, photos, barcodes, `weightKg` stay master.
- **Zone** = customer sees + is charged. **Shop** (`agentSelectServices`) = who fulfills.
- No stock/inventory layer. No VAT in v1. No zone-only SKUs until Phase 4.
- Copy zone A → B copies **override rows**, not the master tree.
- Client-sent prices are ignored. Server resolves from `booking.zoneId`.

## Resolver (only public API for “price in this zone”)

Module: `services/Admin/zoneCatalogService.js`.

| Call | Used for |
|---|---|
| `resolvePrice(zoneId, { subCategoryId \| addOnServiceId \| repairOptionId })` | Every charge write |
| `resolveEnabled` / `resolveAttach` | Browse + attach |
| `getEffectiveCatalog(zoneId)` | Admin Zone Catalog + apps |
| `upsertOverrides` / `resetOverride` / `copyOverrides` | Admin writes + audit |

Flag off → always master (today).

**Forbidden on charge writes:** reading `subCategories.price`, `addOnServices.price`, or `repairOptions.price` directly.

## Overlay tables (v1)

Keyed by **stable master ids**, never `serviceCategories.id`.

| Table | Keys | Fields |
|---|---|---|
| `zoneServiceOverrides` | zone + service | enabled, sort, version |
| `zoneCategoryOverrides` | zone + category | enabled, sort, version |
| `zoneSubCategoryOverrides` | zone + item | enabled, **price**, sort, version |
| `zoneAddOnCategoryOverrides` | zone + add-on category | enabled, sort, version |
| `zoneAddOnServiceOverrides` | zone + add-on | enabled, **price**, sort, version |
| `zoneRepairGarmentOverrides` | zone + garment | enabled, sort, version |
| `zoneRepairOptionOverrides` | zone + option | enabled, **price**, sort, version |
| `zoneSubCategoryAddOnOverrides` | zone + item + add-on category | enabled, version |

Attach effective set = `(master category links ∪ item links) − exclusions`, then zone overlay. Cannot invent a link that does not exist on master. Disabled add-on service hides on all items in that zone.

Cascade: service off → children hidden even if a child override is enabled.

## Money paths that must call the resolver

- Customer / agent / admin catalog browse
- `createBooking`
- Edit order **new** lines (old lines = snapshot)
- Invoice add-on + repair writes / finalize
- Recurring / rebook (current zone, not old snapshot)
- Checkout address → zone change (reprice; drop disabled lines)
- Commission, Stripe amount, min-order, cash-due = **snapshot totals**

Historical display: `customerSelectedService.categoryPrice` and line `price`, not joined live master.

## Phase 0 before any overlay table

1. Fix `createBooking` assigning the **sum** of charges onto every line `categoryPrice`.
2. Server-side price on create (master until flag on).
3. One catalog reader for agent + customer.
4. `categories.serviceId` canonical; `serviceCategories` synced by one function; drift migration.
5. Shared `findZones` (postcode → centroid → geometry).

## Rollout

1. Resolver + tables + wires, flag **false**.
2. Staging: two zones, item + add-on + repair price, attach hide, edit-order, rebook.
3. Prod flag **true**, zero override rows.
4. One pilot zone.
5. Open Zone Catalog UI.

## Deploy

- Idempotent migrations (`tableExists`). Keep `scripts/ensure-live-migrations.js`.
- Do **not** seed override prices.
- Smoke: `GET /health/catalog-resolver` (inherit == master; override row == override).
- Repair catalog already has `GET /health/repair-catalog` — keep it.

## Phase 4 (same ids — no rewrite)

Zone-admin RBAC, `effectiveFrom`/`To`, local SKUs as master rows with `originZoneId` + auto-disable elsewhere, CSV bulk, per-zone flag.

## Related

- Services: `services/Admin/serviceManagementService.js`
- Booking: `services/Customer/customerOrderService.js`
- Invoice: `utils/invoiceLineTotals.js`, `services/Agent/invoiceManagementService.js`
- Zone geo: `services/Admin/postcodeZoneService.js`
- Rule: `.cursor/rules/zone-catalog-overrides.mdc`
