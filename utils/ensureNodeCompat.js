/**
 * firebase-admin@14+ and this repo's engines field require Node 22+.
 * Production fails fast; other environments warn before Firebase init.
 */
function nodeMajorFrom(version) {
  return Number(String(version || '0').split('.')[0]);
}

function assertNodeCompatible(
  nodeVersion = process.versions.node,
  nodeEnv = process.env.NODE_ENV
) {
  const major = nodeMajorFrom(nodeVersion);
  if (!(major > 0 && major < 22)) {
    return { ok: true, major };
  }

  const message =
    `[NodeCompat] Node v${nodeVersion} detected. ` +
    'firebase-admin v14 and engines.node require Node >= 22. ' +
    'Upgrade stage/prod before deploying this dependency set.';

  if (String(nodeEnv || '').toLowerCase() === 'production') {
    throw new Error(message);
  }

  console.warn(message);
  return { ok: false, major, message };
}

const major = nodeMajorFrom(process.versions.node);
assertNodeCompatible(process.versions.node, process.env.NODE_ENV);

module.exports = {
  nodeMajor: major,
  nodeVersion: process.version,
  assertNodeCompatible,
  nodeMajorFrom,
};
