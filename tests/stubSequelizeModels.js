'use strict';

const Module = require('module');

/**
 * Prevent unit tests from opening config.json / MySQL.
 * Install before requiring checkPermission or any file that loads models.
 */
function install() {
  if (install._active) return install._restore;
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (
      request === '../models' ||
      request === '../../models' ||
      request.endsWith('/models') ||
      request.endsWith('\\models')
    ) {
      return {
        sequelize: { query: async () => [], fn() {}, col() {}, literal() {} },
        Sequelize: {},
        users: { findByPk: async () => null, findOne: async () => null },
        roles: { findByPk: async () => null, findAll: async () => [] },
        permissions: { findOne: async () => null },
        features: { findAll: async () => [] },
        zone: { findOne: async () => null },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  install._active = true;
  install._restore = function restore() {
    Module._load = originalLoad;
    install._active = false;
  };
  return install._restore;
}

module.exports = { install };
