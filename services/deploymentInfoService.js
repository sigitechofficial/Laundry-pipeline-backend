'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function parseKeyValueText(text) {
  if (!text) return {};
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      if (!out.releaseName && /^release-/.test(trimmed)) out.releaseName = trimmed;
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

function packageMeta() {
  const pkg = readJsonSafe(path.join(ROOT, 'package.json')) || {};
  return {
    name: pkg.name || null,
    version: pkg.version || null
  };
}

/**
 * Build a public, secret-free deployment snapshot for ops endpoints.
 */
function getDeploymentInfo() {
  const releaseJson =
    readJsonSafe(path.join(ROOT, 'release.json')) ||
    readJsonSafe(path.join(ROOT, 'release-info.json'));
  const releaseTxt = parseKeyValueText(readTextSafe(path.join(ROOT, 'release-info.txt')));
  const pkg = packageMeta();

  const commit =
    (releaseJson && (releaseJson.commit || releaseJson.sha || releaseJson.gitSha)) ||
    releaseTxt.commit ||
    process.env.RELEASE_COMMIT ||
    process.env.GITHUB_SHA ||
    null;

  const shortCommit = commit ? String(commit).slice(0, 8) : null;
  const branch =
    (releaseJson && releaseJson.branch) ||
    releaseTxt.branch ||
    process.env.GITHUB_REF_NAME ||
    null;

  const releaseName =
    (releaseJson && (releaseJson.releaseName || releaseJson.release)) ||
    releaseTxt.releaseName ||
    releaseTxt.release_name ||
    null;

  const deployedAt =
    (releaseJson && (releaseJson.deployedAt || releaseJson.deployed_at_utc || releaseJson.deployedAtUtc)) ||
    releaseTxt.deployed_at_utc ||
    releaseTxt.date ||
    null;

  const packagedAt = (releaseJson && releaseJson.packagedAt) || null;

  return {
    app: (releaseJson && releaseJson.app) || 'laundry-api',
    packageName: pkg.name,
    packageVersion: pkg.version,
    commit,
    shortCommit,
    branch,
    releaseName,
    deployedAt,
    packagedAt,
    deployedBy:
      (releaseJson && (releaseJson.deployedBy || releaseJson.actor)) ||
      releaseTxt.actor ||
      null,
    githubRunId:
      (releaseJson && (releaseJson.runId || releaseJson.githubRunId)) ||
      releaseTxt.runId ||
      null,
    githubRunNumber:
      (releaseJson && (releaseJson.runNumber || releaseJson.githubRunNumber)) ||
      releaseTxt.run ||
      null,
    pm2App:
      (releaseJson && releaseJson.pm2App) ||
      releaseTxt.pm2 ||
      process.env.PM2_APP_NAME ||
      null,
    livePath: (releaseJson && releaseJson.livePath) || null,
    deployRoot: (releaseJson && releaseJson.deployRoot) || null,
    fileBackup: (releaseJson && releaseJson.fileBackup) || releaseTxt.file_backup || null,
    dbBackup: (releaseJson && releaseJson.dbBackup) || releaseTxt.db_backup || null,
    node: {
      version: process.version,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      platform: process.platform,
      arch: process.arch
    },
    env: {
      nodeEnv: process.env.NODE_ENV || null,
      port: process.env.PORT || null
    },
    serverTime: new Date().toISOString(),
    sources: {
      releaseJson: Boolean(releaseJson),
      releaseInfoTxt: Boolean(Object.keys(releaseTxt).length),
      packageJson: Boolean(pkg.name)
    },
    raw: {
      releaseJson: releaseJson || null,
      releaseInfoTxt: releaseTxt
    }
  };
}

module.exports = {
  getDeploymentInfo
};
