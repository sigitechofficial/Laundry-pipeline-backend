/**
 * firebase-admin@13+ needs Node 18+ (global fetch/Headers).
 * Stage historically ran Node 16 — log a clear ops signal early.
 */
const major = Number(String(process.versions.node || '0').split('.')[0]);

if (major > 0 && major < 18) {
  console.warn(
    `[NodeCompat] Node ${process.version} detected. ` +
      'firebase-admin v13 requires Node >= 18 (error: "Headers is not defined"). ' +
      'Upgrade stage/prod PM2 to Node 20, or keep firebase-admin@12.x.'
  );
}

module.exports = { nodeMajor: major, nodeVersion: process.version };
