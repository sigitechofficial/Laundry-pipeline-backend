#!/usr/bin/env node
/**
 * Live DB → Stage DB refresh (read-only on live, overwrite stage).
 *
 * Usage:
 *   PROD_CONFIG_PATH=... STAGE_CONFIG_PATH=... node scripts/live-to-stage-db-sync.js
 *
 * Config files are Sequelize-style JSON ({ production|test|development: {...} })
 * or a flat { username, password, database, host, port }.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.APP_ROOT || process.cwd();
const PROD_CONFIG_PATH =
  process.env.PROD_CONFIG_PATH || path.join(ROOT, 'config', 'config.prod.sync.json');
const STAGE_CONFIG_PATH =
  process.env.STAGE_CONFIG_PATH || path.join(ROOT, 'config', 'config.json');
const BACKUP_DIR =
  process.env.DB_BACKUP_DIR || path.join(ROOT, 'backups');
const STATUS_PATH =
  process.env.DB_SYNC_STATUS_PATH || path.join(BACKUP_DIR, 'live-to-stage-sync-status.json');

function writeStatus( partial) {
  try {
    fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
    let prev = {};
    if (fs.existsSync(STATUS_PATH)) {
      try {
        prev = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
      } catch (e) {
        prev = {};
      }
    }
    const next = Object.assign({}, prev, partial, { updatedAt: new Date().toISOString() });
    fs.writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('Failed to write status file:', e.message);
  }
}

function isPlaceholder(cfg) {
  const db = String((cfg && cfg.database) || '');
  const user = String((cfg && cfg.username) || '');
  return /^your_/i.test(db) || /^your_/i.test(user);
}

function pickConfig(raw, preferredKeys) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config is not an object');
  }
  for (let i = 0; i < preferredKeys.length; i++) {
    const key = preferredKeys[i];
    if (raw[key] && raw[key].database && !isPlaceholder(raw[key])) {
      return raw[key];
    }
  }
  if (raw.database && raw.username && !isPlaceholder(raw)) {
    return raw;
  }
  throw new Error(
    'Could not find a usable DB config. Keys tried: ' + preferredKeys.join(', ')
  );
}

function loadConfig(filePath, preferredKeys) {
  if (!fs.existsSync(filePath)) {
    throw new Error('Config file not found: ' + filePath);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const cfg = pickConfig(raw, preferredKeys);
  return {
    host: cfg.host || '127.0.0.1',
    port: String(cfg.port || 3306),
    username: cfg.username,
    password: cfg.password == null ? '' : String(cfg.password),
    database: cfg.database
  };
}

function findBin(name) {
  const which = spawnSync('bash', ['-lc', 'command -v ' + name], {
    encoding: 'utf8'
  });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }
  const fallbacks = ['/usr/bin/' + name, '/usr/local/bin/' + name];
  for (let i = 0; i < fallbacks.length; i++) {
    if (fs.existsSync(fallbacks[i])) {
      return fallbacks[i];
    }
  }
  throw new Error(name + ' not found on PATH');
}

function runMysqlTool(bin, args, password, label) {
  console.log('>>', label);
  const result = spawnSync(bin, args, {
    env: Object.assign({}, process.env, { MYSQL_PWD: password }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 100
  });
  if (result.status !== 0) {
    const errText = (result.stderr || result.stdout || 'unknown error').slice(0, 2000);
    throw new Error(label + ' failed: ' + errText);
  }
  return result;
}

function countTables(mysqlBin, cfg) {
  const sql =
    "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema='" +
    cfg.database.replace(/'/g, "\\'") +
    "' AND table_type='BASE TABLE'";
  const result = runMysqlTool(
    mysqlBin,
    [
      '-h',
      cfg.host,
      '-P',
      cfg.port,
      '-u',
      cfg.username,
      '-N',
      '-e',
      sql,
      cfg.database
    ],
    cfg.password,
    'count tables on ' + cfg.database
  );
  return String(result.stdout || '').trim();
}

function main() {
  const startedAt = new Date().toISOString();
  writeStatus({
    state: 'running',
    startedAt: startedAt,
    error: null,
    phase: 'init'
  });

  try {
    const prod = loadConfig(PROD_CONFIG_PATH, ['production', 'test', 'development']);
    const stage = loadConfig(STAGE_CONFIG_PATH, ['development', 'test', 'production']);

    if (prod.database === stage.database && prod.host === stage.host) {
      throw new Error(
        'Refusing to sync: live and stage resolve to the same host/database'
      );
    }

    console.log('Live DB:', prod.host + ':' + prod.port + '/' + prod.database);
    console.log('Stage DB:', stage.host + ':' + stage.port + '/' + stage.database);

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stageBackup = path.join(BACKUP_DIR, 'stage-before-live-sync-' + stamp + '.sql');
    const liveDump = path.join(BACKUP_DIR, 'live-dump-' + stamp + '.sql');

    const mysqldump = findBin('mysqldump');
    const mysql = findBin('mysql');

    writeStatus({ phase: 'backup_stage', stageBackup: stageBackup });
    console.log('>> backup stage →', stageBackup);
    const stageDumpResult = spawnSync(
      mysqldump,
      [
        '-h',
        stage.host,
        '-P',
        stage.port,
        '-u',
        stage.username,
        '--single-transaction',
        '--routines',
        '--triggers',
        stage.database
      ],
      {
        env: Object.assign({}, process.env, { MYSQL_PWD: stage.password }),
        encoding: 'buffer',
        maxBuffer: 1024 * 1024 * 512
      }
    );
    if (stageDumpResult.status !== 0) {
      throw new Error(
        'Stage backup failed: ' +
          String(stageDumpResult.stderr || '').slice(0, 2000)
      );
    }
    fs.writeFileSync(stageBackup, stageDumpResult.stdout);
    console.log('Stage backup bytes:', stageDumpResult.stdout.length);

    writeStatus({ phase: 'dump_live', liveDump: liveDump });
    const liveDumpResult = spawnSync(
      mysqldump,
      [
        '-h',
        prod.host,
        '-P',
        prod.port,
        '-u',
        prod.username,
        '--single-transaction',
        '--routines',
        '--triggers',
        prod.database
      ],
      {
        env: Object.assign({}, process.env, { MYSQL_PWD: prod.password }),
        encoding: 'buffer',
        maxBuffer: 1024 * 1024 * 512
      }
    );
    if (liveDumpResult.status !== 0) {
      throw new Error(
        'Live dump failed: ' + String(liveDumpResult.stderr || '').slice(0, 2000)
      );
    }
    fs.writeFileSync(liveDump, liveDumpResult.stdout);
    console.log('Live dump bytes:', liveDumpResult.stdout.length);

    writeStatus({ phase: 'restore_stage' });
    const restore = spawnSync(
      mysql,
      ['-h', stage.host, '-P', stage.port, '-u', stage.username, stage.database],
      {
        env: Object.assign({}, process.env, { MYSQL_PWD: stage.password }),
        input: liveDumpResult.stdout,
        maxBuffer: 1024 * 1024 * 512
      }
    );
    if (restore.status !== 0) {
      throw new Error(
        'Stage restore failed: ' + String(restore.stderr || '').slice(0, 2000)
      );
    }

    const liveTables = countTables(mysql, prod);
    const stageTables = countTables(mysql, stage);

    writeStatus({
      state: 'success',
      phase: 'done',
      finishedAt: new Date().toISOString(),
      stageBackup: stageBackup,
      liveDump: liveDump,
      liveTableCount: liveTables,
      stageTableCount: stageTables,
      error: null
    });

    console.log('Sync complete.');
    console.log('Live table count:', liveTables);
    console.log('Stage table count:', stageTables);
    console.log('Stage backup:', stageBackup);
    process.exit(0);
  } catch (err) {
    console.error(err.message || err);
    writeStatus({
      state: 'failed',
      phase: 'error',
      finishedAt: new Date().toISOString(),
      error: String(err.message || err)
    });
    process.exit(1);
  }
}

main();
