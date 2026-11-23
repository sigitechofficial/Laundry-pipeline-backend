'use strict';

/**
 * Read-only: lists live promotions (active / scheduled) that the campaign rules stop
 * for new orders, e.g. promotions in a draft campaign or one whose end day has passed.
 * Run before releasing the campaign rules: node scripts/campaign-rules-impact.js
 * Nothing is changed.
 */

const { promotion: Promotion, campaign: Campaign, sequelize } = require('../models');
const { campaignBlock } = require('../services/promotions/campaignRules');
const { attachHeldBudget } = require('../services/promotions/campaignBudget');
const { getOperationalTimeZones } = require('../utils/countryTimeZone');

(async () => {
  const now = new Date();
  const rows = await attachHeldBudget(await Promotion.findAll({
    where: { status: ['active', 'scheduled'] },
    attributes: ['id', 'name', 'status', 'campaignId'],
    include: [{ model: Campaign, as: 'campaign', attributes: ['id', 'name', 'status', 'startDate', 'endDate', 'budgetMinor', 'usedBudgetMinor'] }],
    order: [['id', 'ASC']],
  }), { now });

  // A campaign has no zone: its days as seen across every active zone (campaignRules).
  const dated = rows.some((p) => p.campaign && (p.campaign.startDate || p.campaign.endDate));
  const timeZones = dated ? await getOperationalTimeZones() : undefined;
  const stopped = rows
    .map((p) => ({ p, stop: p.campaign ? campaignBlock(p.campaign, now, { timeZones }) : null }))
    .filter((x) => x.stop);

  if (!stopped.length) {
    console.log(`No change: all ${rows.length} live promotions keep running.`);
  } else {
    console.log(`${stopped.length} of ${rows.length} live promotions stop for new orders:`);
    for (const { p, stop } of stopped) {
      const c = p.campaign;
      console.log(`  #${p.id} "${p.name}" (${p.status}) · campaign #${c.id} "${c.name}" ${c.status} ${c.startDate || '…'} → ${c.endDate || '…'} · ${stop.code}`);
    }
  }
  await sequelize.close();
})().catch(async (err) => {
  console.error(err);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
