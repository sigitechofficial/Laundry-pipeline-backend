'use strict';

/**
 * order_adjustments.lineType gains 'service'.
 *
 * The promotion engine prices a discount on the line it changed. A line priced for a whole
 * service with no item (an un-itemised alteration / repair line: subCategoryId NULL,
 * serviceId set) is lineType 'service' with lineItemId = the service id
 * (services/promotions/benefitHandlers.js toAdjustments). Every reader already treats it as
 * its own kind: customerPromotionSummary keys discounts by `service:<id>`, lineItemNames /
 * displayLineName name it from the service catalog, and the agent and customer apps match it
 * to the line by serviceId (PromotionSummaryLine.isService). Only this column's ENUM lacked
 * the value, so writing such an adjustment failed ("Data truncated for column 'lineType'")
 * and every invoice open of that order answered 500 while promotions checkout is on.
 *
 * Appending a member at the end of an ENUM is a metadata-only change in MySQL (no table
 * rebuild, existing values keep their index). Idempotent: reads the live column first and
 * keeps whatever members it has (nothing is dropped or reordered). Down refuses while any row
 * uses 'service' (those adjustments would be lost), then removes the member.
 */
const TABLE = 'order_adjustments';
const COLUMN = 'lineType';
const VALUE = 'service';

async function enumMembers(queryInterface) {
  const [row] = await queryInterface.sequelize.query(
    `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { replacements: { table: TABLE, column: COLUMN }, type: queryInterface.sequelize.QueryTypes.SELECT }
  );
  if (!row) throw new Error(`${TABLE}.${COLUMN} does not exist`);
  const match = /^enum\((.*)\)$/i.exec(String(row.type));
  if (!match) throw new Error(`${TABLE}.${COLUMN} is ${row.type}, expected an ENUM`);
  const members = [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  return { members, nullable: row.nullable === 'YES', def: columnDefault(row.def) };
}

/**
 * The column's default as a plain value. MySQL reports a string default unquoted
 * (basket) and no default as NULL; MariaDB reports it as an SQL literal ('basket')
 * and no default as the string NULL.
 */
function columnDefault(raw) {
  if (raw == null) return null;
  const text = String(raw);
  if (text.toUpperCase() === 'NULL') return null;
  const literal = /^'((?:[^']|'')*)'$/.exec(text);
  return literal ? literal[1].replace(/''/g, "'") : text;
}

async function setMembers(queryInterface, { members, nullable, def }) {
  const q = (v) => queryInterface.sequelize.escape(v);
  await queryInterface.sequelize.query(
    `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`${COLUMN}\` ENUM(${members.map(q).join(', ')})`
      + `${nullable ? ' NULL' : ' NOT NULL'}${def != null ? ` DEFAULT ${q(def)}` : ''}`
  );
}

module.exports = {
  columnDefault,
  async up(queryInterface) {
    const column = await enumMembers(queryInterface);
    if (column.members.includes(VALUE)) return;
    await setMembers(queryInterface, { ...column, members: [...column.members, VALUE] });
  },

  async down(queryInterface) {
    const column = await enumMembers(queryInterface);
    if (!column.members.includes(VALUE)) return;
    const [{ n }] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS n FROM \`${TABLE}\` WHERE \`${COLUMN}\` = :value`,
      { replacements: { value: VALUE }, type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    if (Number(n) > 0) {
      throw new Error(`${n} ${TABLE} row(s) have ${COLUMN} '${VALUE}'; they would be lost. Not reverting.`);
    }
    await setMembers(queryInterface, { ...column, members: column.members.filter((m) => m !== VALUE) });
  },
};
