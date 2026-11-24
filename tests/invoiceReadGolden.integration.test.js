'use strict';

/**
 * Characterisation ("golden") test for the two invoice read endpoints of the agent app:
 *   GET /agent/invoiceCreation/:bookingId
 *   GET /agent/invoice/draft/:bookingId
 *
 * They are on the money path and they are not pure reads: the first open freezes the
 * customer's declared services (transaction + SELECT … FOR UPDATE on the booking), the
 * pricing chain may write billingDetails.discount, promotion order adjustments, promotion
 * hold amounts and customer-credit holds. This harness pins all of it:
 *   - the exact JSON response (status + body; only the per-response `timestamp` and
 *     values stamped "now" during the run are normalised),
 *   - the database rows of the booking afterwards (booking, billing, snapshots, order
 *     adjustments, credit entries/allocations, promotion and coupon redemptions, lines),
 *   - the write / lock statements issued (START TRANSACTION, … FOR UPDATE, INSERT,
 *     UPDATE, DELETE, COMMIT) and the number of queries,
 * for every fixture, for a first open and a re-open, with the promotions checkout flag
 * off and on.
 *
 * Fixtures are seeded into the LOCAL database with fixed ids (bookings 900000+, child rows
 * offset by 10 000 000+), re-created identically before every run, with the auto-increment
 * counters of the tables these GETs write to reset, so two runs start from the same state.
 *
 * Usage (local database only; refuses any other host):
 *   node tests/invoiceReadGolden.integration.test.js record <golden.json> [--root <checkout>]
 *   node tests/invoiceReadGolden.integration.test.js check  <golden.json> [--root <checkout>]
 * Record on the commit before a refactor (e.g. a `git worktree add --detach … main` checkout
 * given as --root), then check on the refactored code. `check` fails on any response or
 * database difference and prints write/lock-trace and query-count differences.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const [mode, goldenFile, ...rest] = process.argv.slice(2);
const rootArg = rest.indexOf('--root');
const ROOT = path.resolve(rootArg >= 0 ? rest[rootArg + 1] : path.join(__dirname, '..'));
if (!['record', 'check'].includes(mode) || !goldenFile) {
    console.error('usage: invoiceReadGolden.integration.test.js record|check <golden.json> [--root <checkout>]');
    process.exit(2);
}
process.chdir(ROOT);
require(path.join(ROOT, 'node_modules/dotenv')).config({ override: true });

const env = process.env.NODE_ENV || 'development';
const dbConfig = require(path.join(ROOT, 'config/config.json'))[env] || {};
if (!['127.0.0.1', 'localhost'].includes(String(dbConfig.host)) || env === 'production') {
    console.error(`Refusing to run: database host "${dbConfig.host}" (NODE_ENV=${env}) is not local.`);
    process.exit(2);
}

const RUN_STARTED = Date.now();
const SHOP_USER_ID = 2; // local fixture shop owner (shop@justdrycleans.test), shop address 1
const GOLDEN_ZONE_ID = 900;
const GOLDEN_COUPON_ID = 900001;
const GOLDEN_PROMOTION_NAME = 'GOLDEN invoice-read 10% off';
const BOOKING_MIN = 900000;
const BOOKING_MAX = 999999;

/**
 * Fixtures: booking id → { source booking to clone, tweaks }. Sources are local seed
 * orders of shop 1 (scripts/seed-local-orders.js).
 */
const FIXTURES = [
    // One per booking status the shop app opens an invoice in.
    ...[162, 166, 167, 168, 169, 171, 172, 174, 175, 176, 177, 178, 179, 184].map((src) => ({
        id: BOOKING_MIN + src, source: src, label: `status-of-${src}`,
    })),
    { id: 910001, source: 169, label: 'draft-with-repair-items', repair: true },
    { id: 910002, source: 171, label: 'finalized-card-with-held-credit', credit: { held: 3, lot: 10 } },
    { id: 910003, source: 169, label: 'draft-with-reserved-promotion', promotion: true },
    { id: 910004, source: 169, label: 'draft-with-coupon', coupon: true },
    { id: 910005, source: 172, label: 'paid-at-booking', paidAtBooking: true },
    { id: 910006, source: 169, label: 'zero-items-at-shop', noLines: true, set: { invoiceStatus: 'none' } },
    { id: 910007, source: 169, label: 'draft-in-usd-zone', set: { zoneId: GOLDEN_ZONE_ID } },
    { id: 910008, source: 169, label: 'draft-with-existing-snapshot', copySnapshots: true },
    { id: 910009, source: 184, label: 'cancelled-with-held-credit', credit: { held: 2, lot: 5 }, cancelRecord: true },
    { id: 910010, source: 169, label: 'draft-express-weight-and-delicate-items', lineServices: [6, 7] },
    { id: 910011, source: 169, label: 'other-shops-booking', set: { laundryShopId: 18 } },
    { id: 910012, source: 176, label: 'cash-out-for-delivery-with-tip', tip: 4.5 },
    { id: 910013, source: 169, label: 'draft-promotion-coupon-credit-repair', promotion: true, coupon: true, credit: { held: 1, lot: 6 }, repair: true },
];

/** Child tables cloned with the booking (`refs` columns are offset like ids). */
const CLONED = [
    { table: 'customerSelectedServices', by: 'bookingId' },
    { table: 'customerSelectedServiceLines', by: 'customerSelectedServiceId', refs: ['customerSelectedServiceId'] },
    { table: 'customerSelectedServiceAddOns', by: 'customerSelectedServiceId', refs: ['customerSelectedServiceId', 'customerSelectedServiceLineId'] },
    { table: 'bookingPreferences', by: 'bookingId', refs: ['customerSelectedServiceId'] },
    { table: 'servicePreferences', by: 'bookingId' },
    { table: 'billingDetails', by: 'bookingId' },
    { table: 'tips', by: 'bookingId' },
    { table: 'bookingCollectionImages', by: 'bookingId' },
    { table: 'OnHoldConfirmations', by: 'bookingId' },
    { table: 'proofOfDeliveries', by: 'bookingId' },
];

/** Tables the GETs may write to: emptied for the fixtures and their counters reset. */
const SIDE_EFFECT_TABLES = [
    'customerOriginalServiceSnapshots',
    'customerOriginalPreferenceSnapshots',
    'order_adjustments',
    'customer_credit_allocations',
    'customer_credit_entries',
    'promotion_redemptions',
    'couponRedemptions',
    'cancelBookings',
    'customerSelectedRepairItemOptions',
    'customerSelectedRepairItemImages',
    'customerSelectedRepairItems',
];

/** What is compared after each call, per fixture booking. */
const STATE_QUERIES = {
    booking: 'SELECT * FROM bookings WHERE id = :id',
    billing: 'SELECT * FROM billingDetails WHERE bookingId = :id ORDER BY id',
    lines: 'SELECT * FROM customerSelectedServices WHERE bookingId = :id ORDER BY id',
    snapshots: 'SELECT * FROM customerOriginalServiceSnapshots WHERE bookingId = :id ORDER BY id',
    preferenceSnapshots: 'SELECT * FROM customerOriginalPreferenceSnapshots WHERE bookingId = :id ORDER BY id',
    // Ids of order adjustments are not compared: re-writing identical adjustments on every
    // read (new ids each time) is the behaviour being removed; their content must match.
    orderAdjustments: 'SELECT bookingId, adjustmentClass, promotionId, promotionVersionId, couponCodeId, couponCode, lineType, lineItemId, lineDescription, amount, currency, label, description, appliedBy, reversedAt FROM order_adjustments WHERE bookingId = :id ORDER BY adjustmentClass, promotionId, lineType, lineItemId, amount',
    creditEntries: 'SELECT * FROM customer_credit_entries WHERE bookingId = :id OR idempotencyKey LIKE CONCAT(\'golden:\', :id, \':%\') ORDER BY id',
    creditAllocations: 'SELECT a.* FROM customer_credit_allocations a JOIN customer_credit_entries e ON e.id = a.spendEntryId WHERE e.bookingId = :id ORDER BY a.id',
    promotionRedemptions: 'SELECT * FROM promotion_redemptions WHERE bookingId = :id ORDER BY id',
    couponRedemptions: 'SELECT * FROM couponRedemptions WHERE bookingId = :id ORDER BY id',
};

// ─── Instrumentation: every query issued while a call runs ─────────────────────
const { Sequelize } = require(path.join(ROOT, 'node_modules/sequelize'));
let trace = null;
const originalQuery = Sequelize.prototype.query;
Sequelize.prototype.query = async function (sql, ...args) {
    const text = typeof sql === 'string' ? sql : (sql && sql.query) || '';
    const started = process.hrtime.bigint();
    try {
        return await originalQuery.call(this, sql, ...args);
    } finally {
        if (trace) {
            trace.queries += 1;
            trace.dbMs += Number(process.hrtime.bigint() - started) / 1e6;
            if (/^\s*(START TRANSACTION|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE)|FOR UPDATE|LOCK IN SHARE MODE/i.test(text)) {
                trace.writes.push(normaliseSql(text));
            }
        }
    }
};

function normaliseSql(text) {
    return text
        .replace(/`/g, '')
        .replace(/'\d{4}-\d{2}-\d{2}[ T][\d:.]+(?:Z|[+-]\d{2}:\d{2})?'/g, "'<time>'")
        .replace(/\b\d+(?:\.\d+)?\b/g, '?')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
}

/** Values stamped "now" by this run (row timestamps, response timestamp) → "<now>". */
function normaliseValue(value) {
    if (value instanceof Date) value = value.toISOString();
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value)) {
        const t = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
        if (Number.isFinite(t) && t >= RUN_STARTED - 120000) return '<now>';
    }
    return value;
}
function normalise(node) {
    if (Array.isArray(node)) return node.map(normalise);
    if (node && typeof node === 'object' && !(node instanceof Date)) {
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            // Development error bodies carry a stack trace (file paths, line numbers).
            if (k === 'stack') continue;
            out[k] = k === 'timestamp' ? '<timestamp>' : normalise(v);
        }
        return out;
    }
    return normaliseValue(node);
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────
const models = require(path.join(ROOT, 'models'));
const { sequelize } = models;
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
const exec = (sql, replacements = {}) => sequelize.query(sql, { replacements });

async function columnsOf(table) {
    const rows = await q('SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table ORDER BY ORDINAL_POSITION', { table });
    return rows.map((r) => r.c);
}

/** INSERT … SELECT copy with id (and listed refs) offset, bookingId replaced. */
async function cloneRows(table, whereSql, replacements, { offset, bookingId, refs = [], set = {} }) {
    const cols = await columnsOf(table);
    const select = cols.map((c) => {
        if (Object.prototype.hasOwnProperty.call(set, c)) return `:set_${c}`;
        if (c === 'id' || refs.includes(c)) return `IF(\`${c}\` IS NULL, NULL, \`${c}\` + ${offset})`;
        if (c === 'bookingId') return String(bookingId);
        return `\`${c}\``;
    });
    const params = { ...replacements };
    for (const [k, v] of Object.entries(set)) params[`set_${k}`] = v;
    await exec(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(',')}) SELECT ${select.join(',')} FROM \`${table}\` WHERE ${whereSql}`, params);
}

async function deleteFixtures() {
    const inRange = `BETWEEN ${BOOKING_MIN} AND ${BOOKING_MAX}`;
    await exec(`DELETE a FROM customer_credit_allocations a JOIN customer_credit_entries e ON e.id = a.spendEntryId OR e.id = a.lotEntryId WHERE e.bookingId ${inRange} OR e.idempotencyKey LIKE 'golden:%'`);
    await exec(`DELETE FROM customer_credit_entries WHERE bookingId ${inRange} OR idempotencyKey LIKE 'golden:%'`);
    await exec(`DELETE o FROM customerSelectedRepairItemOptions o JOIN customerSelectedRepairItems r ON r.id = o.customerSelectedRepairItemId WHERE r.bookingId ${inRange}`);
    await exec(`DELETE i FROM customerSelectedRepairItemImages i JOIN customerSelectedRepairItems r ON r.id = i.customerSelectedRepairItemId WHERE r.bookingId ${inRange}`);
    await exec(`DELETE FROM customerSelectedRepairItems WHERE bookingId ${inRange}`);
    await exec(`DELETE a FROM customerSelectedServiceAddOns a JOIN customerSelectedServices s ON s.id = a.customerSelectedServiceId WHERE s.bookingId ${inRange}`);
    await exec(`DELETE l FROM customerSelectedServiceLines l JOIN customerSelectedServices s ON s.id = l.customerSelectedServiceId WHERE s.bookingId ${inRange}`);
    for (const t of ['bookingPreferences', 'servicePreferences', 'billingDetails', 'tips', 'bookingCollectionImages', 'OnHoldConfirmations', 'proofOfDeliveries', 'customerOriginalPreferenceSnapshots', 'customerOriginalServiceSnapshots', 'order_adjustments', 'promotion_redemptions', 'couponRedemptions', 'cancelBookings', 'customerSelectedServices']) {
        await exec(`DELETE FROM \`${t}\` WHERE bookingId ${inRange}`);
    }
    await exec(`DELETE FROM bookings WHERE id ${inRange}`);
    // Next ids of the tables the GETs write to start where they would on a clean copy.
    for (const t of SIDE_EFFECT_TABLES) await exec(`ALTER TABLE \`${t}\` AUTO_INCREMENT = 1`);
}

async function ensureReferenceData() {
    await exec(`INSERT INTO zones (id, name, status, zoneMinimumAmount, zoneAdminComission, serviceCharge, createdAt, updatedAt, agentCommissionPercent, cityId, currencyUnitId, distanceUnitId)
        SELECT ${GOLDEN_ZONE_ID}, 'GOLDEN USD zone', 1, 20.00, zoneAdminComission, 3.75, '2026-01-01', '2026-01-01', agentCommissionPercent, cityId, 4, distanceUnitId
        FROM zones WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM zones WHERE id = ${GOLDEN_ZONE_ID})`);
    await exec(`INSERT INTO coupons (id, code, description, discountType, discountValue, minOrderAmount, maxDiscountCap, usageLimit, usedCount, perUserLimit, startDate, expiryDate, isActive, createdAt, updatedAt, zoneIds)
        SELECT ${GOLDEN_COUPON_ID}, 'GOLDEN10', 'golden test coupon', 'percentage', 10, NULL, NULL, NULL, 0, 99, '2026-01-01', '2030-01-01', 1, '2026-01-01', '2026-01-01', NULL
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM coupons WHERE id = ${GOLDEN_COUPON_ID})`);
    const existing = await q('SELECT id FROM promotions WHERE name = :name', { name: GOLDEN_PROMOTION_NAME });
    if (existing.length) return existing[0].id;
    const promoAdmin = require(path.join(ROOT, 'services/Admin/promotionAdminService'));
    const created = await promoAdmin.createPromotion({
        name: GOLDEN_PROMOTION_NAME,
        visibility: 'public',
        perCustomerLimit: null,
        zoneScopeMode: 'all',
        benefitType: 'basket_discount',
        discountMode: 'percent',
        discountValue: 10,
        currency: 'GBP',
        startDate: '2026-01-01',
        endDate: '2030-01-01',
    }, 1, null);
    await promoAdmin.publishPromotion(created.id, 1, 'golden fixture', null);
    return created.id;
}

async function seed() {
    const promotionId = await ensureReferenceData();
    await deleteFixtures();
    for (const [index, fx] of FIXTURES.entries()) {
        const offset = 10000000 + index * 10000;
        const src = fx.source;
        const set = { ...(fx.set || {}) };
        if (fx.paidAtBooking) set.paymentConfirmed = 1;
        await cloneRows('bookings', 'id = :src', { src }, { offset: fx.id - src, bookingId: fx.id, set: { ...set, orderTrackId: `GOLD-${fx.id}` } });
        if (!fx.noLines) {
            await cloneRows('customerSelectedServices', 'bookingId = :src', { src }, {
                offset, bookingId: fx.id,
            });
            const lineIds = `SELECT id FROM customerSelectedServices WHERE bookingId = ${Number(src)}`;
            await cloneRows('customerSelectedServiceLines', `customerSelectedServiceId IN (${lineIds})`, {}, { offset, bookingId: fx.id, refs: ['customerSelectedServiceId'] });
            await cloneRows('customerSelectedServiceAddOns', `customerSelectedServiceId IN (${lineIds})`, {}, { offset, bookingId: fx.id, refs: ['customerSelectedServiceId', 'customerSelectedServiceLineId'] });
            await cloneRows('bookingPreferences', 'bookingId = :src', { src }, { offset, bookingId: fx.id, refs: ['customerSelectedServiceId'] });
        }
        for (const t of ['servicePreferences', 'billingDetails', 'tips', 'bookingCollectionImages', 'OnHoldConfirmations', 'proofOfDeliveries']) {
            await cloneRows(t, 'bookingId = :src', { src }, { offset, bookingId: fx.id });
        }
        const lines = await q('SELECT id FROM customerSelectedServices WHERE bookingId = :id AND status = 1 ORDER BY id', { id: fx.id });
        if (fx.lineServices && lines.length) {
            for (const [i, serviceId] of fx.lineServices.entries()) {
                if (lines[i]) await exec('UPDATE customerSelectedServices SET serviceId = :serviceId WHERE id = :id', { serviceId, id: lines[i].id });
            }
        }
        if (fx.paidAtBooking) {
            await exec("UPDATE billingDetails SET paymentStatus = 'Paid', upfrontAmount = 40.00 WHERE bookingId = :id", { id: fx.id });
        }
        if (fx.copySnapshots) {
            await cloneRows('customerOriginalServiceSnapshots', 'bookingId = :src', { src }, { offset, bookingId: fx.id });
            await cloneRows('customerOriginalPreferenceSnapshots', 'bookingId = :src', { src }, { offset, bookingId: fx.id, refs: ['snapshotServiceId'] });
        }
        if (fx.tip) {
            await exec(`INSERT INTO tips (id, bookingId, amount, createdAt, updatedAt, source, paymentType, paidAt) VALUES (${offset + 1}, :id, :amount, '2026-02-01', '2026-02-01', 'extra', 'cash', NULL)`, { id: fx.id, amount: fx.tip });
        }
        if (fx.repair) {
            // Alteration line + garments: one on the line, one booking-level (service 9 by id
            // only) and one for a service the order has no line for (placeholder path).
            const lineId = offset + 9001;
            await exec(`INSERT INTO customerSelectedServices (id, bookingId, serviceId, categoryId, subCategoryId, categoryPrice, items, status, createdAt, updatedAt, date, time)
                SELECT ${lineId}, :id, 9, categoryId, subCategoryId, 12.00, 2, 1, '2026-02-01', '2026-02-01', date, time FROM customerSelectedServices WHERE bookingId = :id ORDER BY id LIMIT 1`, { id: fx.id });
            await exec(`INSERT INTO customerSelectedRepairItems (id, bookingId, customerSelectedServiceId, serviceId, repairGarmentId, garmentName, quantity, instruction, createdAt, updatedAt) VALUES
                (${offset + 1}, :id, ${lineId}, 9, 1, 'Trousers', 2, 'Hem 2cm', '2026-02-01', '2026-02-01'),
                (${offset + 2}, :id, NULL, 9, 2, 'Dress', 1, NULL, '2026-02-01', '2026-02-01'),
                (${offset + 3}, :id, NULL, 3, 3, 'Coat', 1, 'Button', '2026-02-01', '2026-02-01')`, { id: fx.id });
            await exec(`INSERT INTO customerSelectedRepairItemOptions (id, customerSelectedRepairItemId, repairOptionId, optionName, price, createdAt, updatedAt) VALUES
                (${offset + 1}, ${offset + 1}, 1, 'Shorten', 8.50, '2026-02-01', '2026-02-01'),
                (${offset + 2}, ${offset + 1}, 2, 'Taper', 6.00, '2026-02-01', '2026-02-01'),
                (${offset + 3}, ${offset + 3}, 3, 'Replace button', 2.00, '2026-02-01', '2026-02-01')`);
            await exec(`INSERT INTO customerSelectedRepairItemImages (id, customerSelectedRepairItemId, imageUrl, sortOrder, createdAt, updatedAt) VALUES
                (${offset + 1}, ${offset + 1}, 'Public/golden/hem.jpg', 1, '2026-02-01', '2026-02-01'),
                (${offset + 2}, ${offset + 1}, 'Public/golden/hem-0.jpg', 0, '2026-02-01', '2026-02-01')`);
        }
        const [{ customerId, zoneId }] = await q('SELECT customerId, zoneId FROM bookings WHERE id = :id', { id: fx.id });
        const currency = Number(zoneId) === GOLDEN_ZONE_ID ? 'USD' : 'GBP';
        if (fx.credit) {
            await exec(`INSERT INTO customer_credit_entries (id, customerId, type, status, amount, remainingAmount, currency, expiresAt, bookingId, idempotencyKey, description, actorType, createdAt, updatedAt) VALUES
                (${offset + 1}, :customerId, 'ADJUST', 'POSTED', :lot, :lotLeft, :currency, '2030-01-01', NULL, 'golden:${fx.id}:lot', 'golden lot', 'system', '2026-02-01', '2026-02-01'),
                (${offset + 2}, :customerId, 'SPEND', 'HELD', :spend, NULL, :currency, NULL, :id, 'golden:${fx.id}:spend', 'Used on order', 'system', '2026-02-01', '2026-02-01')`,
            { customerId, currency, id: fx.id, lot: fx.credit.lot, lotLeft: fx.credit.lot - fx.credit.held, spend: -fx.credit.held });
            await exec(`INSERT INTO customer_credit_allocations (id, spendEntryId, lotEntryId, amount, createdAt) VALUES (${offset + 1}, ${offset + 2}, ${offset + 1}, :held, '2026-02-01')`, { held: fx.credit.held });
        }
        if (fx.promotion) {
            await exec(`INSERT INTO promotion_redemptions (id, promotionId, customerId, bookingId, status, currency, zoneId, idempotencyKey, reservedAt, reservationExpiresAt, estimatedAmount, createdAt, updatedAt) VALUES
                (${offset + 1}, :promotionId, :customerId, :id, 'RESERVED', :currency, :zoneId, 'golden:${fx.id}:promo', '2026-02-01', '2030-01-01', 1.50, '2026-02-01', '2026-02-01')`,
            { promotionId, customerId, id: fx.id, currency, zoneId });
        }
        if (fx.coupon) {
            await exec(`INSERT INTO couponRedemptions (id, couponId, userId, bookingId, discountAmt, createdAt, updatedAt) VALUES (${offset + 1}, ${GOLDEN_COUPON_ID}, :customerId, :id, 0.00, '2026-02-01', '2026-02-01')`, { customerId, id: fx.id });
        }
        if (fx.cancelRecord) {
            await exec(`INSERT INTO cancelBookings (id, reasonText, createdAt, updatedAt, bookingId, userId) VALUES (${offset + 1}, 'golden cancel', '2026-02-01', '2026-02-01', :id, :customerId)`, { id: fx.id, customerId });
        }
    }
}

async function stateOf(bookingId) {
    const out = {};
    for (const [name, sql] of Object.entries(STATE_QUERIES)) {
        out[name] = normalise(JSON.parse(JSON.stringify(await q(sql, { id: bookingId }))));
    }
    return out;
}

// ─── Calls through the real agent router (auth + permission middleware) ───────
let server;
let token;
async function startServer() {
    const express = require(path.join(ROOT, 'node_modules/express'));
    const app = express();
    app.use(express.json());
    app.use('/agent', require(path.join(ROOT, 'routes/agent')));
    const { universalErrorHandler } = require(path.join(ROOT, 'middlewares/universalErrorHandler'));
    app.use(universalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { openAppSession, resolveSessionIdentity } = require(path.join(ROOT, 'utils/appSession'));
    token = await openAppSession({
        userId: SHOP_USER_ID,
        claims: { id: SHOP_USER_ID, email: 'shop@justdrycleans.test' },
        identity: resolveSessionIdentity({ deviceId: '00000000-0000-4000-8000-00000000901d' }),
    });
}

function get(urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, headers: { accesstoken: token } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let body;
                try { body = JSON.parse(text); } catch { body = text; }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function runAll() {
    const results = {};
    for (const flag of ['false', 'true']) {
        process.env.PROMOTIONS_CHECKOUT_ENABLED = flag;
        await seed();
        for (const fx of FIXTURES) {
            for (const [endpoint, url] of [['invoiceCreation', `/agent/invoiceCreation/${fx.id}`], ['draft', `/agent/invoice/draft/${fx.id}`]]) {
                for (const open of ['first', 'again']) {
                    trace = { queries: 0, dbMs: 0, writes: [] };
                    const res = await get(url);
                    const t = trace;
                    trace = null;
                    results[`promotions=${flag} ${fx.id} ${fx.label} ${endpoint} ${open}`] = {
                        response: { status: res.status, body: normalise(res.body) },
                        state: await stateOf(fx.id),
                        writes: t.writes,
                        queries: t.queries,
                        dbMs: Number(t.dbMs.toFixed(1)),
                    };
                }
            }
        }
    }
    return results;
}

function firstDifference(a, b, at = '') {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            const d = firstDifference(a[k], b[k], `${at}.${k}`);
            if (d) return d;
        }
    }
    return `${at || '(root)'}: golden ${JSON.stringify(a)?.slice(0, 300)} ≠ now ${JSON.stringify(b)?.slice(0, 300)}`;
}

(async () => {
    await startServer();
    const results = await runAll();
    if (mode === 'record') {
        fs.writeFileSync(goldenFile, JSON.stringify(results, null, 1));
        console.log(`recorded ${Object.keys(results).length} calls → ${goldenFile}`);
    } else {
        const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
        assert.deepStrictEqual(Object.keys(results), Object.keys(golden), 'same calls');
        let failures = 0;
        let queriesBefore = 0;
        let queriesAfter = 0;
        let dbBefore = 0;
        let dbAfter = 0;
        for (const [key, now] of Object.entries(results)) {
            const was = golden[key];
            queriesBefore += was.queries;
            queriesAfter += now.queries;
            dbBefore += was.dbMs;
            dbAfter += now.dbMs;
            for (const part of ['response', 'state']) {
                const d = firstDifference(was[part], now[part]);
                if (d) {
                    failures += 1;
                    console.log(`FAIL ${key} ${part} ${d}`);
                }
            }
            if (JSON.stringify(was.writes) !== JSON.stringify(now.writes)) {
                console.log(`WRITES ${key}\n   golden: ${JSON.stringify(was.writes)}\n   now:    ${JSON.stringify(now.writes)}`);
            }
            console.log(`queries ${key}: ${was.queries} → ${now.queries}`);
        }
        const calls = Object.keys(results).length;
        console.log(`\n${calls} calls; queries ${queriesBefore} → ${queriesAfter}; DB time ${dbBefore.toFixed(1)} → ${dbAfter.toFixed(1)} ms`);
        if (failures) {
            console.log(`${failures} response/state difference(s)`);
            process.exitCode = 1;
        } else {
            console.log('invoiceReadGolden: responses and database state identical to the golden run');
        }
    }
    server.close();
    await deleteFixtures();
    process.exit(process.exitCode || 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
