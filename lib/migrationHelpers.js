'use strict';

/**
 * Shared helpers so greenfield + existing DBs both migrate cleanly.
 */

async function tableExists(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  const target = String(tableName).toLowerCase();
  return tables.some((t) => String(t).toLowerCase() === target);
}

async function columnExists(queryInterface, tableName, columnName) {
  if (!(await tableExists(queryInterface, tableName))) return false;
  const def = await queryInterface.describeTable(tableName);
  return Object.prototype.hasOwnProperty.call(def, columnName);
}

async function addColumnIfMissing(queryInterface, tableName, columnName, spec) {
  if (await columnExists(queryInterface, tableName, columnName)) return false;
  await queryInterface.addColumn(tableName, columnName, spec);
  return true;
}

async function removeColumnIfExists(queryInterface, tableName, columnName) {
  if (!(await columnExists(queryInterface, tableName, columnName))) return false;
  await queryInterface.removeColumn(tableName, columnName);
  return true;
}

module.exports = {
  tableExists,
  columnExists,
  addColumnIfMissing,
  removeColumnIfExists,
};
