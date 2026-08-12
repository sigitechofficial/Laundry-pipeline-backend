const { users, employeeCapabilityOverride } = require('../../models');
const {
    ValidationError,
    NotFoundError,
    ForbiddenError,
} = require('../../middlewares/universalErrorHandler');
const {
    SHOP_CAPABILITY_KEYS,
    ROLE_CAPABILITY_CEILINGS,
    getShopCapabilities,
    getRoleCapabilityCeiling,
    loadCapabilityOverrides,
    getEffectiveShopCapabilities,
    isShopOwner,
    isShopManager,
} = require('../../utils/shopAgentContext');
const { CLASSIFIED_AS } = require('../../constants/systemRoles');

/**
 * Per-employee capability override CRUD (clamped by role ceilings).
 */
class EmployeeCapabilityService {
    async _assertEmployeeOfShop(employeeId, shopOwnerId) {
        const employee = await users.findOne({
            where: {
                id: Number(employeeId),
                employeeOff: Number(shopOwnerId),
                classifiedAsId: CLASSIFIED_AS.LAUNDRY_SHOP_EMPLOYEE,
            },
            attributes: [
                'id',
                'firstName',
                'lastName',
                'roleId',
                'classifiedAsId',
                'employeeOff',
                'status',
            ],
        });
        if (!employee) {
            throw new NotFoundError('Employee not found for this shop');
        }
        return employee;
    }

    async getForEmployee(employeeId, shopOwnerId) {
        const employee = await this._assertEmployeeOfShop(employeeId, shopOwnerId);
        const plain = employee.get({ plain: true });
        const base = getShopCapabilities(plain);
        const overrides = await loadCapabilityOverrides(plain.id);
        const ceiling = getRoleCapabilityCeiling(plain);
        const effective = await getEffectiveShopCapabilities(plain);

        return {
            employeeId: plain.id,
            roleId: plain.roleId,
            base,
            ceiling,
            overrides,
            effective,
        };
    }

    /**
     * @param {number} employeeId
     * @param {number} shopOwnerId
     * @param {Record<string, boolean>} capsMap
     * @param {object} actorUser - req.user of the actor setting caps
     */
    async setForEmployee(employeeId, shopOwnerId, capsMap, actorUser) {
        if (!actorUser || (!isShopOwner(actorUser) && !isShopManager(actorUser))) {
            throw new ForbiddenError('Only the shop owner or manager can set employee capabilities');
        }

        const employee = await this._assertEmployeeOfShop(employeeId, shopOwnerId);
        const plain = employee.get({ plain: true });
        const ceiling = getRoleCapabilityCeiling(plain);
        const map = capsMap && typeof capsMap === 'object' ? capsMap : {};

        const rows = [];
        for (const key of SHOP_CAPABILITY_KEYS) {
            if (key === 'canRunAssignedJobs') continue;
            if (!Object.prototype.hasOwnProperty.call(map, key)) continue;

            // Never allow finance for non-owner employees
            if (key === 'canManageFinance') {
                if (map[key] === true) {
                    throw new ForbiddenError(
                        'canManageFinance cannot be granted to shop employees'
                    );
                }
                rows.push({ capabilityKey: key, allowed: false });
                continue;
            }

            let allowed = map[key] === true;
            if (ceiling[key] === false && allowed) {
                throw new ValidationError(
                    `Capability ${key} exceeds role ceiling for this employee`
                );
            }
            if (ceiling[key] === false) {
                allowed = false;
            }

            // Manager actor cannot grant above their own ceiling either
            if (isShopManager(actorUser) && !isShopOwner(actorUser)) {
                const actorCeiling = ROLE_CAPABILITY_CEILINGS.manager;
                if (actorCeiling[key] === false && allowed) {
                    throw new ForbiddenError(
                        `Managers cannot grant ${key}`
                    );
                }
            }

            rows.push({ capabilityKey: key, allowed });
        }

        if (!rows.length) {
            throw new ValidationError('No valid capability keys provided');
        }

        for (const row of rows) {
            await employeeCapabilityOverride.upsert({
                userId: plain.id,
                capabilityKey: row.capabilityKey,
                allowed: row.allowed,
            });
        }

        return this.getForEmployee(employeeId, shopOwnerId);
    }
}

module.exports = new EmployeeCapabilityService();
