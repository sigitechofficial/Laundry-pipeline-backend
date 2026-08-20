'use strict';

/**
 * Dev-only CORS helper for same-WiFi Vite (http://192.168.x.x:5174).
 * Never used to open production CORS to the public internet.
 */

function ipv4Octets(hostname) {
  const parts = String(hostname || '').split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isPrivateLanHostname(hostname) {
  const host = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();

  if (host === 'localhost' || host === '::1') return true;

  const octets = ipv4Octets(host);
  if (!octets) return false;

  const [a, b] = octets;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * @param {string} origin
 * @param {string} [nodeEnv]
 * @returns {boolean}
 */
function isDevPrivateLanOrigin(origin, nodeEnv = process.env.NODE_ENV) {
  if (String(nodeEnv || '').toLowerCase() === 'production') return false;
  if (!origin || typeof origin !== 'string') return false;

  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    return isPrivateLanHostname(url.hostname);
  } catch {
    return false;
  }
}

module.exports = {
  isPrivateLanHostname,
  isDevPrivateLanOrigin,
};
