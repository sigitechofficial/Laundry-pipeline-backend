'use strict';

/**
 * Default feature CRUD permissions for system roles — audiences kept separate:
 *
 * Agent shop staff:
 *   6 Driver  → Agent Employee / both features (read-only)
 *   8 Manager → Agent / Agent Employee / both (broader CRUD)
 *
 * Admin portal staff:
 *   7 Zone Admin → Admin / both features (full CRUD)
 *
 * Never assign Admin-only features to roles 6/8, or Agent Employee-only features to role 7.
 * Shop ops capabilities are enforced in utils/shopAgentContext — not these rows alone.
 *
 * Idempotent: inserts only missing (roleId, featureId) pairs.
 */

const DRIVER_ROLE_ID = 6;
const ZONE_ADMIN_ROLE_ID = 7;
const MANAGER_ROLE_ID = 8;

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [features] = await queryInterface.sequelize.query(
      `SELECT id, featureOf FROM features
       WHERE status = 1
         AND deletedAt IS NULL
         AND featureOf IN ('Admin', 'Agent', 'Agent Employee', 'both')`
    );

    if (!features || features.length === 0) {
      console.log(
        '[seed] No features found — skip default system role permissions'
      );
      return;
    }

    const [existing] = await queryInterface.sequelize.query(
      `SELECT roleId, featureId FROM permissions
       WHERE roleId IN (${DRIVER_ROLE_ID}, ${ZONE_ADMIN_ROLE_ID}, ${MANAGER_ROLE_ID})`
    );
    const existingKeys = new Set(
      (existing || []).map((r) => `${r.roleId}:${r.featureId}`)
    );

    const now = new Date();
    const rows = [];

    for (const feature of features) {
      const featureId = feature.id;
      const featureOf = feature.featureOf;

      // ── Driver (6): Agent Employee + both, read-only ─────────────────────
      if (
        (featureOf === 'Agent Employee' || featureOf === 'both') &&
        !existingKeys.has(`${DRIVER_ROLE_ID}:${featureId}`)
      ) {
        rows.push({
          featureId,
          roleId: DRIVER_ROLE_ID,
          create: false,
          read: true,
          update: false,
          delete: false,
          createdAt: now,
          updatedAt: now,
        });
      }

      // ── Manager (8): Agent app features — never Admin-only ───────────────
      if (
        (featureOf === 'Agent' ||
          featureOf === 'Agent Employee' ||
          featureOf === 'both') &&
        !existingKeys.has(`${MANAGER_ROLE_ID}:${featureId}`)
      ) {
        const isAgentOwnerFeature = featureOf === 'Agent';
        rows.push({
          featureId,
          roleId: MANAGER_ROLE_ID,
          create: !isAgentOwnerFeature,
          read: true,
          update: true,
          delete: !isAgentOwnerFeature,
          createdAt: now,
          updatedAt: now,
        });
      }

      // ── Zone Admin (7): Admin + both only — never Agent Employee-only ────
      if (
        (featureOf === 'Admin' || featureOf === 'both') &&
        !existingKeys.has(`${ZONE_ADMIN_ROLE_ID}:${featureId}`)
      ) {
        rows.push({
          featureId,
          roleId: ZONE_ADMIN_ROLE_ID,
          create: true,
          read: true,
          update: true,
          delete: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    if (rows.length === 0) {
      console.log('[seed] System role default permissions already present');
      return;
    }

    await queryInterface.bulkInsert('permissions', rows);
    console.log(
      `[seed] Inserted ${rows.length} default permissions for roles 6/7/8 (audiences separated)`
    );
  },

  async down() {
    // Do not wipe customized permissions.
  },
};
