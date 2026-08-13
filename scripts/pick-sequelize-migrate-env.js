#!/usr/bin/env node
/**
 * Pick the Sequelize CLI env that matches THIS deploy target's database.
 *
 * Bug we hit: always preferring `development` made prod deploys migrate the
 * stage DB (already up to date) while prod `.env` / live schema stayed behind.
 *
 * Usage (prints env name to stdout):
 *   node scripts/pick-sequelize-migrate-env.js
 *
 * Optional env:
 *   LIVE_PATH, PM2_APP_NAME, APP_URL, SEQUELIZE_ENV (forced override)
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadDotEnv(root) {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function isPlaceholder(c) {
  return (
    !c ||
    !c.database ||
    !c.username ||
    /^your_/i.test(c.database) ||
    /^your_/i.test(c.username || '')
  );
}

function isLaundry(c) {
  const t = `${c.database || ''} ${c.username || ''}`.toLowerCase();
  return /laund/.test(t) && !/fomino/.test(t);
}

function main() {
  if (process.env.SEQUELIZE_ENV && process.env.SEQUELIZE_ENV.trim()) {
    process.stdout.write(process.env.SEQUELIZE_ENV.trim());
    return;
  }

  const root = process.cwd();
  const cfgPath = path.join(root, 'config', 'config.json');
  if (!fs.existsSync(cfgPath)) {
    process.stdout.write('development');
    return;
  }

  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const live = String(
    process.env.LIVE_PATH || process.env.APP_URL || ''
  ).toLowerCase();
  const pm2 = String(process.env.PM2_APP_NAME || '').toLowerCase();
  const dotenv = loadDotEnv(root);
  const envDb = String(
    process.env.DB_NAME || dotenv.DB_NAME || dotenv.DATABASE || ''
  ).toLowerCase();

  const entries = Object.keys(raw || {})
    .map((k) => ({ k, c: raw[k] }))
    .filter((e) => e.c && e.c.database && !isPlaceholder(e.c) && isLaundry(e.c));

  // 1) Exact match against live .env database name
  if (envDb) {
    const hit = entries.find(
      (e) => String(e.c.database || '').toLowerCase() === envDb
    );
    if (hit) {
      process.stdout.write(hit.k);
      return;
    }
  }

  // 2) Deploy target heuristics
  let preferred = ['development', 'production', 'test'];
  const isProdTarget =
    live.includes('prodlaundry') ||
    live.includes('prod.') ||
    pm2 === 'laundary' ||
    /production/i.test(process.env.NODE_ENV || '');
  const isStageTarget =
    live.includes('stagelaundry') ||
    live.includes('stage.') ||
    pm2.includes('stage');

  if (isProdTarget && !isStageTarget) {
    preferred = ['production', 'development', 'test'];
  } else if (isStageTarget) {
    preferred = ['development', 'production', 'test'];
  }

  for (const k of preferred) {
    const hit = entries.find((e) => e.k === k);
    if (hit) {
      process.stdout.write(hit.k);
      return;
    }
  }

  if (entries[0]) {
    process.stdout.write(entries[0].k);
    return;
  }

  process.stdout.write('development');
}

main();
