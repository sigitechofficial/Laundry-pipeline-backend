'use strict';

const net = require('net');
const db = require('../../models');
const { ValidationError } = require('../../middlewares/universalErrorHandler');

const { shopPrinter } = db;

function serializePrinter(row) {
  if (!row) {
    return {
      exists: false,
      enabled: false,
      ipAddress: '',
      port: 9100,
      paperWidthMm: 76,
      partialCut: true,
      shopDisplayName: '',
      configured: false,
      updatedAt: null,
    };
  }
  const plain = row.toJSON ? row.toJSON() : row;
  return {
    exists: true,
    enabled: !!plain.enabled,
    ipAddress: plain.ipAddress || '',
    port: plain.port || 9100,
    paperWidthMm: plain.paperWidthMm === 58 ? 58 : 76,
    partialCut: plain.partialCut !== false,
    shopDisplayName: plain.shopDisplayName || '',
    configured: !!(plain.enabled && plain.ipAddress),
    updatedAt: plain.updatedAt || null,
  };
}

function normalizePrinterBody(body = {}) {
  const ipAddress = String(body.ipAddress || '').trim();
  const enabled = body.enabled === true;
  const port = body.port == null || body.port === '' ? 9100 : Number(body.port);

  if (ipAddress && net.isIPv4(ipAddress) === false) {
    throw new ValidationError('Enter a valid printer IPv4 address, e.g. 192.168.1.50');
  }
  if (enabled && !ipAddress) {
    throw new ValidationError('Printer IP is required when the printer is enabled');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('Port must be a number between 1 and 65535');
  }

  return {
    enabled,
    ipAddress: ipAddress || null,
    port,
    paperWidthMm: Number(body.paperWidthMm) === 58 ? 58 : 76,
    partialCut: body.partialCut !== false,
    shopDisplayName: String(body.shopDisplayName || '').trim().slice(0, 120) || null,
  };
}

async function getShopPrinter(shopUserId) {
  const row = await shopPrinter.findOne({ where: { shopUserId } });
  return serializePrinter(row);
}

async function saveShopPrinter(shopUserId, body) {
  const values = normalizePrinterBody(body);
  const [row, created] = await shopPrinter.findOrCreate({
    where: { shopUserId },
    defaults: { shopUserId, ...values },
  });
  if (!created) await row.update(values);
  return serializePrinter(row);
}

module.exports = {
  serializePrinter,
  normalizePrinterBody,
  getShopPrinter,
  saveShopPrinter,
};
