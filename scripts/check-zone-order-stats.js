#!/usr/bin/env node
/**
 * Compare zone-scoped order counts vs list API for a zone name (e.g. RM8).
 *
 * Usage (stage/local API):
 *   ADMIN_TOKEN='eyJ...' BASE_URL='https://stagelaundry.sigisolutions.net/' \\
 *     node scripts/check-zone-order-stats.js RM8
 *
 * Usage (direct DB — config/config.json or DB_* env):
 *   node scripts/check-zone-order-stats.js RM8 --db
 */
'use strict';

const fs = require('fs');
const path = require('path');

const zoneNeedle = (process.argv[2] || 'RM8').trim();
const useDb = process.argv.includes('--db');

function loadDbConfig() {
  const fromEnv =
    process.env.DB_HOST &&
    process.env.DB_NAME &&
    process.env.DB_USER != null;
  if (fromEnv) {
    return {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      database: process.env.DB_NAME,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
    };
  }
  const cfgPath = path.join(__dirname, '../config/config.json');
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const key = process.env.NODE_ENV || 'development';
  return raw[key] || raw.development;
}

async function checkViaDb() {
  const { Sequelize } = require('sequelize');
  const cfg = loadDbConfig();
  const seq = new Sequelize(cfg.database, cfg.username, cfg.password, {
    host: cfg.host,
    port: cfg.port,
    dialect: 'mysql',
    logging: false,
  });
  await seq.authenticate();

  const [zones] = await seq.query(
    `SELECT id, name, postcodes FROM zones
     WHERE deletedAt IS NULL AND (
       LOWER(name) LIKE LOWER(?) OR CAST(postcodes AS CHAR) LIKE ?
     )`,
    { replacements: [`%${zoneNeedle}%`, `%${zoneNeedle}%`] }
  );

  if (!zones.length) {
    const [sample] = await seq.query(
      'SELECT id, name FROM zones WHERE deletedAt IS NULL ORDER BY id LIMIT 30'
    );
    console.log(`No zone matching "${zoneNeedle}". Sample zones:`, sample);
    await seq.close();
    return;
  }

  const [allBookings] = await seq.query(
    'SELECT COUNT(*) AS c FROM bookings WHERE deletedAt IS NULL'
  );

  for (const z of zones) {
    const [cnt] = await seq.query(
      'SELECT COUNT(*) AS c FROM bookings WHERE deletedAt IS NULL AND zoneId = ?',
      { replacements: [z.id] }
    );
    const [nullZone] = await seq.query(
      'SELECT COUNT(*) AS c FROM bookings WHERE deletedAt IS NULL AND zoneId IS NULL'
    );
    const [sample] = await seq.query(
      `SELECT id, orderTrackId, zoneId, createdAt, bookingStatusId
       FROM bookings WHERE deletedAt IS NULL AND zoneId = ?
       ORDER BY id DESC LIMIT 10`,
      { replacements: [z.id] }
    );
    console.log('\n=== DB ===');
    console.log({ zoneId: z.id, zoneName: z.name, postcodes: z.postcodes });
    console.log({
      bookingsInZone: Number(cnt[0].c),
      allBookings: Number(allBookings[0].c),
      bookingsWithNullZone: Number(nullZone[0].c),
    });
    console.log('Latest bookings in zone:', sample);
  }
  await seq.close();
}

async function apiGet(baseUrl, token, pathname, params = {}) {
  const url = new URL(pathname.replace(/^\//, ''), baseUrl);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && String(v).trim() !== '') url.searchParams.set(k, String(v));
  });
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'ngrok-skip-browser-warning': 'true',
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function normalizeZones(body) {
  const d = body?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.zones)) return d.zones;
  return [];
}

async function checkViaApi() {
  const token = process.env.ADMIN_TOKEN || process.env.LAUNDRY_ADMIN_TOKEN;
  const baseUrl =
    process.env.BASE_URL ||
    process.env.LAUNDRY_API_BASE_URL ||
    'https://stagelaundry.sigisolutions.net/';
  if (!token) {
    console.error(
      'Set ADMIN_TOKEN (Bearer from admin panel localStorage accessToken) to query stage API.'
    );
    process.exit(1);
  }

  const zonesRes = await apiGet(baseUrl, token, 'admin/getZones');
  if (zonesRes.status !== 200 || zonesRes.body?.status !== '1') {
    console.error('getZones failed', zonesRes.status, zonesRes.body?.message);
    process.exit(1);
  }

  const zones = normalizeZones(zonesRes.body).filter((z) => {
    const name = String(z.name ?? z.zoneName ?? '');
    const pc = JSON.stringify(z.postcodes ?? '');
    return (
      name.toLowerCase().includes(zoneNeedle.toLowerCase()) ||
      pc.toUpperCase().includes(zoneNeedle.toUpperCase())
    );
  });

  if (!zones.length) {
    console.log(
      `No zone matching "${zoneNeedle}" in getZones. All names:`,
      normalizeZones(zonesRes.body).map((z) => `${z.id}:${z.name}`).join(', ')
    );
    process.exit(0);
  }

  for (const z of zones) {
    const zoneId = z.id ?? z.zoneId;
    const counts = await apiGet(baseUrl, token, 'admin/ordersCount', { zoneId });
    const list = await apiGet(baseUrl, token, 'admin/allOrderDetails', {
      page: 1,
      limit: 25,
      zoneId,
    });

    const countData = counts.body?.data ?? {};
    const listData = list.body?.data ?? {};
    const rows = listData.orderDetails ?? [];
    const pagination = listData.pagination ?? {};

    const rowZoneIds = [...new Set(rows.map((b) => b.zoneId))];
    const mismatched = rows.filter(
      (b) => b.zoneId != null && Number(b.zoneId) !== Number(zoneId)
    );

    console.log('\n=== API (stage) ===');
    console.log({ zoneId, zoneName: z.name });
    console.log('ordersCount.allOrderCount:', countData.allOrderCount);
    console.log('allOrderDetails.pagination:', pagination);
    console.log('allOrderDetails.rowsReturned:', rows.length);
    console.log('distinct zoneId on page:', rowZoneIds);
    if (mismatched.length) {
      console.warn('WARNING: rows with wrong zoneId:', mismatched.map((b) => b.id));
    }
    console.log(
      'First 5 orders:',
      rows.slice(0, 5).map((b) => ({
        id: b.id,
        orderTrackId: b.orderTrackId,
        zoneId: b.zoneId,
        createdAt: b.createdAt,
        statusId: b.bookingStatusId,
      }))
    );

    const unfiltered = await apiGet(baseUrl, token, 'admin/allOrderDetails', {
      page: 1,
      limit: 5,
    });
    const unfilteredTotal =
      unfiltered.body?.data?.pagination?.totalRecords ?? '?';
    console.log('\nCompare: all zones totalRecords (page 1):', unfilteredTotal);
    console.log(
      'Filter effective?',
      pagination.totalRecords !== unfilteredTotal &&
        pagination.totalRecords <= Number(countData.allOrderCount)
    );
  }
}

(async () => {
  if (useDb) {
    await checkViaDb();
  } else {
    await checkViaApi();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
