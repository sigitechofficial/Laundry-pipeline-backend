'use strict';

/**
 * MariaDB stores JSON as text and returns it as a string ('[25]'); MySQL returns the
 * parsed value ([25]). Only JSON-looking text is parsed, so a plain string value such
 * as 'card' reads the same on both.
 */
function parseJsonValue(raw) {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === 'string' && /^\s*[[{"]/.test(value); i += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

/** A Sequelize JSON attribute that always reads as parsed JSON, on MySQL and MariaDB. */
function jsonColumn(DataTypes, name, options = {}) {
  return {
    type: DataTypes.JSON,
    ...options,
    get() {
      return parseJsonValue(this.getDataValue(name));
    },
  };
}

module.exports = { jsonColumn, parseJsonValue };
